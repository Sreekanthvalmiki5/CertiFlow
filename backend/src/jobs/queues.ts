// BullMQ queues. Two work queues so CPU-bound PDF rendering and rate-limited
// WhatsApp delivery scale independently; one maintenance queue for scheduled
// sweeps (BullMQ guarantees one run per tick across all worker replicas).
import { Queue } from 'bullmq';
import { config } from '../config';
import { createRedis } from '../infra';

export const QUEUE = { pdf: 'certificate-pdf', delivery: 'certificate-delivery', maintenance: 'maintenance' } as const;

const connection = createRedis('queues');

// removeOnComplete/Fail: finished jobs are deleted, so a later re-enqueue by
// the reconciler with the same jobId is accepted. While a job is waiting or
// running, its jobId dedupes duplicate enqueues (e.g. outbox replays).
const defaults = { removeOnComplete: true, removeOnFail: true };

export const pdfQueue = new Queue(QUEUE.pdf, {
  connection,
  defaultJobOptions: { ...defaults, attempts: 5, backoff: { type: 'exponential', delay: 1000 } },
});

export const deliveryQueue = new Queue(QUEUE.delivery, {
  connection,
  defaultJobOptions: {
    ...defaults,
    attempts: config.whatsappAttempts,
    backoff: { type: 'exponential', delay: config.whatsappBackoffMs },
  },
});

export const maintenanceQueue = new Queue(QUEUE.maintenance, { connection, defaultJobOptions: defaults });

export interface CertJob {
  certificateId: string;
  requestId?: string;
}

export const pdfJobId = (id: string) => `pdf-${id}`;
export const deliveryJobId = (id: string) => `deliver-${id}`;

export async function enqueuePdf(ids: string[], requestId?: string) {
  if (!ids.length) return;
  await pdfQueue.addBulk(
    ids.map((certificateId) => ({ name: 'render', data: { certificateId, requestId } satisfies CertJob, opts: { jobId: pdfJobId(certificateId) } })),
  );
}

export async function enqueueDelivery(certificateId: string, requestId?: string) {
  await deliveryQueue.add('send', { certificateId, requestId } satisfies CertJob, { jobId: deliveryJobId(certificateId) });
}

export async function closeQueues() {
  await Promise.all([pdfQueue.close(), deliveryQueue.close(), maintenanceQueue.close()]);
  connection.disconnect();
}
