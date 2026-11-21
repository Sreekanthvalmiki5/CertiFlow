// Moment 3: a batch of 60 is approved. Every candidate ends up with exactly
// one certificate on their phone, even though WhatsApp is unreliable.
// Runs the REAL pipeline: outbox relay -> BullMQ -> PDF -> WhatsApp stand-in
// configured to fail, throttle and (worst case) deliver-then-time-out.
import { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeQueues, enqueuePdf } from '../src/jobs/queues';
import { relayOutboxOnce } from '../src/jobs/handlers';
import { RunningWorkers, startWorkers } from '../src/jobs/workers';
import { prisma } from '../src/infra';
import { createMockWhatsApp } from '../src/mock-whatsapp/app';
import { approveFully, resetAll, submittedBatch, waitFor } from './helpers';

describe('Moment 3 - 60 certificates over an unreliable WhatsApp', () => {
  const provider = createMockWhatsApp({
    failureRate: 0.25, // 503 before sending
    rateLimitRate: 0.05, // 429
    timeoutRate: 0.15, // delivered, but the answer comes after our 250ms timeout
    hangMs: 600,
    latencyMs: 20,
  });
  let server: Server;
  let workers: RunningWorkers;

  beforeAll(async () => {
    await resetAll();
    server = provider.app.listen(47100);
    workers = await startWorkers({ schedules: false });
  });

  afterAll(async () => {
    await workers.stop();
    await closeQueues();
    server.close();
  });

  it('delivers exactly one message per candidate, with unique certificate numbers', async () => {
    const batchId = await submittedBatch(60, 'BIG', 9500000000);
    await approveFully(batchId, true); // 60 >= threshold: goes via the quality team

    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.status).toBe('APPROVED');

    // The approval request returned immediately; delivery happens in the background.
    await waitFor(async () => (await prisma.certificate.count({ where: { batchId, deliveryStatus: 'SENT' } })) === 60, 80_000, 200);

    const certs = await prisma.certificate.findMany({ where: { batchId } });
    expect(certs).toHaveLength(60);
    expect(new Set(certs.map((c) => c.number)).size).toBe(60);
    expect(new Set(certs.map((c) => c.candidateId)).size).toBe(60);
    expect(certs.every((c) => c.pdfPath)).toBe(true);

    // What actually reached phones:
    const messages = provider.messages();
    expect(messages).toHaveLength(60);
    const perPhone = new Map<string, number>();
    for (const m of messages) perPhone.set(m.to, (perPhone.get(m.to) ?? 0) + 1);
    expect(perPhone.size).toBe(60);
    expect([...perPhone.values()].every((n) => n === 1)).toBe(true);

    // Prove the provider really misbehaved during the run.
    expect(provider.stats.failures + provider.stats.rateLimited).toBeGreaterThan(0);
    expect(provider.stats.timeouts).toBeGreaterThan(0);
    // Timed-out-but-delivered sends were retried and de-duplicated by key.
    expect(provider.stats.duplicatesSuppressed).toBeGreaterThan(0);
  });

  it('replaying every event and job (as after a crash) sends nothing twice', async () => {
    const before = provider.messages().length;
    await prisma.outboxEvent.updateMany({ data: { publishedAt: null } }); // pretend the relay never ran
    await relayOutboxOnce(1000);
    const all = await prisma.certificate.findMany({ select: { id: true } });
    await enqueuePdf(all.map((c) => c.id)); // and the reconciler fired too
    await new Promise((r) => setTimeout(r, 3000));
    expect(provider.messages()).toHaveLength(before);
    expect(await prisma.certificate.count()).toBe(60);
  });
});
