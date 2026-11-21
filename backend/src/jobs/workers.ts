// Wires BullMQ workers + the outbox relay loop. Used by src/worker.ts and by
// the integration tests (which run the real pipeline in-process).
import { Worker } from 'bullmq';
import { config } from '../config';
import { createRedis, logger } from '../infra';
import { handleDelivery, handlePdf, reconcilePendingCertificates, relayOutboxOnce, sweepStuckBatches } from './handlers';
import { CertJob, maintenanceQueue, QUEUE } from './queues';

export interface RunningWorkers {
  stop: () => Promise<void>;
}

export async function startWorkers(opts: { schedules?: boolean } = {}): Promise<RunningWorkers> {
  const connection = createRedis('workers');

  const pdfWorker = new Worker<CertJob>(QUEUE.pdf, async (job) => handlePdf(job.data.certificateId, job.data.requestId), {
    connection,
    concurrency: 4,
  });

  const deliveryWorker = new Worker<CertJob>(
    QUEUE.delivery,
    async (job) =>
      handleDelivery(job.data.certificateId, {
        requestId: job.data.requestId,
        isFinalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
      }),
    // The limiter is global across all replicas (enforced in Redis), which is
    // how we stay under the provider's messages-per-second cap at peak.
    { connection, concurrency: 10, limiter: { max: config.whatsappRatePerSec, duration: 1000 } },
  );

  const maintenanceWorker = new Worker(
    QUEUE.maintenance,
    async (job) => {
      if (job.name === 'sla-sweep') return { escalated: await sweepStuckBatches() };
      if (job.name === 'reconcile') return { requeued: await reconcilePendingCertificates() };
    },
    { connection, concurrency: 1 },
  );

  for (const w of [pdfWorker, deliveryWorker, maintenanceWorker]) {
    w.on('failed', (job, err) => logger.debug({ queue: w.name, jobId: job?.id, err: err.message }, 'job attempt failed'));
    w.on('error', (err) => logger.warn({ queue: w.name, err: err.message }, 'worker error'));
  }

  if (opts.schedules !== false) {
    await maintenanceQueue.upsertJobScheduler('sla-sweep', { every: config.slaSweepIntervalMs }, { name: 'sla-sweep' });
    await maintenanceQueue.upsertJobScheduler('reconcile', { every: config.reconcileIntervalMs }, { name: 'reconcile' });
  }

  // Outbox relay loop: drains in batches, sleeps briefly when idle.
  let running = true;
  const relayDone = (async () => {
    while (running) {
      let relayed = 0;
      try {
        relayed = await relayOutboxOnce();
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'outbox relay failed; will retry');
      }
      if (!relayed) await new Promise((r) => setTimeout(r, config.outboxPollMs));
    }
  })();

  logger.info('workers started');
  return {
    stop: async () => {
      running = false;
      await relayDone;
      await Promise.all([pdfWorker.close(), deliveryWorker.close(), maintenanceWorker.close()]);
      connection.disconnect();
    },
  };
}
