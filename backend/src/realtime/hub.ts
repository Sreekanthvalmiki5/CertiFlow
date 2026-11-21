// Server-Sent Events hub. Each API instance subscribes to the Redis channel
// and forwards events only to connected users allowed to see that batch.
import { Response } from 'express';
import { canSeeBatch } from '../domain/batchService';
import { Actor } from '../domain/workflow';
import { createRedis, logger } from '../infra';
import { REALTIME_CHANNEL, RealtimeEvent } from './publish';

interface Client {
  actor: Actor;
  res: Response;
}

const clients = new Set<Client>();
let started = false;

export function startRealtimeHub() {
  if (started) return;
  started = true;
  const sub = createRedis('realtime-sub');
  sub.subscribe(REALTIME_CHANNEL).catch((err) => logger.warn({ err: err.message }, 'realtime subscribe failed'));
  sub.on('message', (_channel, raw) => {
    let event: RealtimeEvent;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    for (const c of clients) {
      if (canSeeBatch(c.actor, event)) c.res.write(`event: update\ndata: ${JSON.stringify(event)}\n\n`);
    }
  });
  // Heartbeat keeps proxies from closing idle connections.
  setInterval(() => {
    for (const c of clients) c.res.write(': ping\n\n');
  }, 20_000).unref();
}

export function attachClient(actor: Actor, res: Response) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(`event: ready\ndata: {}\n\n`);
  const client = { actor, res };
  clients.add(client);
  res.on('close', () => clients.delete(client));
}
