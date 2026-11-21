// API process entrypoint. Stateless: any number of replicas behind a load
// balancer; realtime fan-out goes through Redis pub/sub.
import { createApp } from './app';
import { config } from './config';
import { logger, prisma, redis } from './infra';
import { startRealtimeHub } from './realtime/hub';
import { closeQueues } from './jobs/queues';

startRealtimeHub();
const server = createApp().listen(config.port, () => logger.info({ port: config.port }, 'api listening'));

async function shutdown(signal: string) {
  logger.info({ signal }, 'api shutting down');
  server.close();
  await closeQueues();
  await prisma.$disconnect();
  redis.disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
