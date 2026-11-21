// Worker process entrypoint. Run as many replicas as needed; all coordination
// happens through Postgres row locks and Redis queues.
import { closeQueues } from './jobs/queues';
import { startWorkers } from './jobs/workers';
import { logger, prisma, redis } from './infra';

async function main() {
  const workers = await startWorkers();
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'worker shutting down');
    // Close gracefully: in-flight jobs finish; anything interrupted is retried.
    await workers.stop();
    await closeQueues();
    await prisma.$disconnect();
    redis.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'worker failed to start');
  process.exit(1);
});
