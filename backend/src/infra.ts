// Shared infrastructure clients: Prisma, Redis, logger.
import { PrismaClient } from '@prisma/client';
import IORedis, { Redis } from 'ioredis';
import pino from 'pino';
import { config } from './config';

export const logger = pino({ level: config.logLevel, base: { service: process.env.SERVICE_NAME ?? 'certiflow' } });

export const prisma = new PrismaClient();

// BullMQ requires maxRetriesPerRequest = null on its connections.
export function createRedis(purpose: string): Redis {
  const client = new IORedis(config.redisUrl, { maxRetriesPerRequest: null, lazyConnect: false });
  client.on('error', (err) => logger.warn({ err: err.message, purpose }, 'redis error'));
  return client;
}

// General-purpose connection for cache / rate limit / publish.
export const redis = createRedis('general');
