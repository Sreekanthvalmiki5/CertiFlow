// Stand-in WhatsApp provider. Behaves like an unreliable real provider:
//  - fails with 503 before sending          (failureRate)
//  - throttles with 429                      (rateLimitRate)
//  - DELIVERS the message but answers late   (timeoutRate) -> the caller times
//    out without knowing it succeeded. This is the case that causes duplicate
//    messages in naive systems.
// It honours an Idempotency-Key header like mainstream messaging APIs do, and
// exposes each phone's "inbox" so tests and the demo can see what arrived.
import crypto from 'node:crypto';
import fs from 'node:fs';
import express from 'express';

export interface MockOptions {
  failureRate: number;
  timeoutRate: number;
  rateLimitRate: number;
  hangMs: number;
  latencyMs: number;
  persistFile?: string;
  random?: () => number;
}

export interface Message {
  id: string;
  to: string;
  text: string;
  document?: { url: string; filename: string };
  idempotencyKey: string;
  receivedAt: string;
}

export function createMockWhatsApp(initial: MockOptions) {
  const opts = { ...initial };
  const rand = opts.random ?? Math.random;
  const byKey = new Map<string, Message>();
  const stats = { requests: 0, failures: 0, timeouts: 0, rateLimited: 0, delivered: 0, duplicatesSuppressed: 0 };

  // Survive restarts of the provider container (a real provider would too).
  if (opts.persistFile && fs.existsSync(opts.persistFile)) {
    for (const line of fs.readFileSync(opts.persistFile, 'utf8').split('\n')) {
      if (line.trim()) {
        const m = JSON.parse(line) as Message;
        byKey.set(m.idempotencyKey, m);
      }
    }
  }
  const persist = (m: Message) => opts.persistFile && fs.appendFileSync(opts.persistFile, JSON.stringify(m) + '\n');

  const app = express();
  app.use(express.json({ limit: '100kb' }));

  app.post('/v1/messages', async (req, res) => {
    stats.requests++;
    const key = req.header('idempotency-key');
    const { to, text, document } = req.body ?? {};
    if (!key || typeof to !== 'string' || !/^\+\d{10,15}$/.test(to)) {
      return res.status(400).json({ error: 'idempotency-key header and E.164 "to" are required' });
    }
    if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs * rand()));

    const existing = byKey.get(key);
    if (existing) {
      stats.duplicatesSuppressed++;
      return res.json({ id: existing.id, duplicate: true });
    }
    const roll = rand();
    if (roll < opts.failureRate) {
      stats.failures++;
      return res.status(503).json({ error: 'temporarily unavailable' });
    }
    if (roll < opts.failureRate + opts.rateLimitRate) {
      stats.rateLimited++;
      return res.status(429).json({ error: 'rate limited' });
    }
    const msg: Message = { id: `wamid.${crypto.randomUUID()}`, to, text: String(text ?? ''), document, idempotencyKey: key, receivedAt: new Date().toISOString() };
    byKey.set(key, msg);
    persist(msg);
    stats.delivered++;
    if (roll < opts.failureRate + opts.rateLimitRate + opts.timeoutRate) {
      // Delivered, but the response is too slow for the client to wait for.
      stats.timeouts++;
      await new Promise((r) => setTimeout(r, opts.hangMs));
    }
    if (!res.headersSent && !res.destroyed) res.json({ id: msg.id, duplicate: false });
  });

  // Demo/test helpers (a real provider would deliver to the phone instead).
  app.get('/v1/messages', (req, res) => {
    const to = typeof req.query.to === 'string' ? req.query.to : undefined;
    const all = [...byKey.values()];
    res.json(to ? all.filter((m) => m.to === to) : all);
  });
  app.get('/v1/stats', (_req, res) => res.json({ ...stats, config: { ...opts, random: undefined } }));
  app.post('/v1/config', (req, res) => {
    for (const k of ['failureRate', 'timeoutRate', 'rateLimitRate', 'hangMs', 'latencyMs'] as const) {
      if (typeof req.body?.[k] === 'number') opts[k] = req.body[k];
    }
    res.json({ ok: true });
  });
  app.get('/health', (_req, res) => res.json({ ok: true }));

  return { app, messages: () => [...byKey.values()], stats, opts, reset: () => byKey.clear() };
}
