// Realtime events go over Redis pub/sub so that every API instance can push
// them to the browsers connected to it. Payloads carry ids and statuses only,
// never personal data; clients refetch what they are allowed to see.
import { logger, redis } from '../infra';

export const REALTIME_CHANNEL = 'certiflow:events';

export interface RealtimeEvent {
  type: string;
  batchId: string;
  centreId: string;
  districtId: string;
  status?: string;
  certificateId?: string;
  at: string;
}

export async function publishRealtime(event: Omit<RealtimeEvent, 'at'>) {
  try {
    await redis.publish(REALTIME_CHANNEL, JSON.stringify({ ...event, at: new Date().toISOString() }));
  } catch (err) {
    // Realtime is a convenience; the source of truth is still in Postgres.
    logger.warn({ err: (err as Error).message }, 'realtime publish failed');
  }
}
