// Job handlers. Each one is idempotent: running it twice (after a crash, a
// redelivered job, an outbox replay or a reconciler sweep) has the same
// effect as running it once. That is what lets workers restart at any moment.
import fs from 'node:fs/promises';
import { Prisma } from '@prisma/client';
import { config } from '../config';
import { audit, DomainEvent } from '../domain/audit';
import { writeCertificatePdf } from '../domain/pdf';
import { invalidateVerification } from '../domain/verification';
import { ProviderError, sendCertificateMessage } from '../domain/whatsappClient';
import { logger, prisma } from '../infra';
import { signDownloadToken } from '../lib/tokens';
import { publishRealtime } from '../realtime/publish';
import { enqueueDelivery, enqueuePdf } from './queues';
import { PENDING_STATUSES } from '../domain/workflow';

async function fileExists(p: string) {
  return fs.access(p).then(() => true, () => false);
}

async function realtimeForCert(certificateId: string, type: string) {
  const cert = await prisma.certificate.findUnique({ where: { id: certificateId }, include: { batch: { include: { centre: true } } } });
  if (!cert) return;
  await publishRealtime({ type, batchId: cert.batchId, centreId: cert.batch.centreId, districtId: cert.batch.centre.districtId, certificateId });
}

// ---------------------------------------------------------------- outbox relay

/**
 * Relay unpublished outbox rows. Rows are claimed with FOR UPDATE SKIP LOCKED,
 * so several worker replicas can relay in parallel without double-processing,
 * and marked published in the same transaction. If the process dies mid-way
 * the transaction rolls back and the rows are relayed again (at-least-once);
 * downstream handlers are idempotent, so that is safe.
 */
export async function relayOutboxOnce(limit = 100): Promise<number> {
  return prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<{ id: bigint; type: string; payload: DomainEvent }[]>`
        SELECT id, type, payload FROM outbox_events
        WHERE "publishedAt" IS NULL ORDER BY id LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
      for (const row of rows) await dispatch(row.payload);
      if (rows.length) {
        await tx.outboxEvent.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { publishedAt: new Date() } });
      }
      return rows.length;
    },
    { timeout: 30_000 },
  );
}

async function dispatch(event: DomainEvent) {
  if (event.type === 'batch.approved') {
    const certs = await prisma.certificate.findMany({ where: { batchId: event.batchId, status: 'VALID' }, select: { id: true } });
    await enqueuePdf(certs.map((c) => c.id), event.requestId);
  }
  if (event.type === 'certificate.revoked' && event.certificateNumber) {
    await invalidateVerification(event.certificateNumber);
  }
  await publishRealtime({
    type: event.type,
    batchId: event.batchId,
    centreId: event.centreId,
    districtId: event.districtId,
    status: event.status,
    certificateId: event.certificateId,
  });
}

// ------------------------------------------------------------------ PDF stage

export async function handlePdf(certificateId: string, requestId?: string) {
  const cert = await prisma.certificate.findUnique({ where: { id: certificateId } });
  if (!cert || cert.status === 'REVOKED') return 'skipped';
  if (!(cert.pdfPath && (await fileExists(cert.pdfPath)))) {
    const pdfPath = await writeCertificatePdf({ ...cert, centreName: cert.centreName });
    await prisma.$transaction(async (tx) => {
      await tx.certificate.update({ where: { id: certificateId }, data: { pdfPath, pdfGeneratedAt: new Date() } });
      await audit(tx, { entityType: 'certificate', entityId: certificateId, batchId: cert.batchId, action: 'certificate.pdf_generated', requestId });
    });
  }
  if (cert.deliveryStatus !== 'SENT') await enqueueDelivery(certificateId, requestId);
  return 'ok';
}

// ------------------------------------------------------------- delivery stage

export function downloadUrl(certificateId: string) {
  return `${config.publicBaseUrl}/api/public/certificates/${certificateId}/download?t=${signDownloadToken(certificateId)}`;
}

/**
 * Send the certificate over WhatsApp. `isFinalAttempt` lets us mark the
 * certificate FAILED (visible to the state office) when retries run out.
 */
export async function handleDelivery(certificateId: string, opts: { isFinalAttempt: boolean; requestId?: string }) {
  const cert = await prisma.certificate.findUnique({ where: { id: certificateId } });
  if (!cert || cert.status === 'REVOKED' || cert.deliveryStatus === 'SENT') return 'skipped';
  if (!cert.pdfPath) {
    await enqueuePdf([certificateId], opts.requestId);
    return 'waiting-for-pdf';
  }

  await prisma.certificate.update({ where: { id: certificateId }, data: { deliveryAttempts: { increment: 1 } } });
  try {
    const result = await sendCertificateMessage({
      idempotencyKey: `certificate-${certificateId}`,
      to: cert.phone,
      text: `Congratulations ${cert.holderName}! Your Pragati Skills Mission certificate ${cert.number} for "${cert.course}" is ready.`,
      documentUrl: downloadUrl(certificateId),
      filename: `${cert.number}.pdf`,
    });
    await prisma.$transaction(async (tx) => {
      // Conditional update: only the first successful attempt flips the state.
      const updated = await tx.certificate.updateMany({
        where: { id: certificateId, deliveryStatus: { not: 'SENT' } },
        data: { deliveryStatus: 'SENT', deliveredAt: new Date(), providerMessageId: result.messageId, lastDeliveryError: null },
      });
      if (updated.count) {
        await audit(tx, {
          entityType: 'certificate',
          entityId: certificateId,
          batchId: cert.batchId,
          action: 'certificate.delivered',
          details: { providerMessageId: result.messageId, providerSaidDuplicate: result.duplicate },
          requestId: opts.requestId,
        });
      }
    });
    await realtimeForCert(certificateId, 'certificate.delivered');
    return 'sent';
  } catch (err) {
    const retryable = err instanceof ProviderError ? err.retryable : true;
    const message = (err as Error).message;
    const giveUp = !retryable || opts.isFinalAttempt;
    await prisma.$transaction(async (tx) => {
      await tx.certificate.update({
        where: { id: certificateId },
        data: { lastDeliveryError: message, ...(giveUp ? { deliveryStatus: 'FAILED' } : {}) },
      });
      if (giveUp) {
        await audit(tx, { entityType: 'certificate', entityId: certificateId, batchId: cert.batchId, action: 'certificate.delivery_failed', details: { error: message }, requestId: opts.requestId });
      }
    });
    if (giveUp) {
      await realtimeForCert(certificateId, 'certificate.delivery_failed');
      return 'failed';
    }
    logger.info({ certificateId, err: message }, 'delivery attempt failed; will retry');
    throw err; // BullMQ schedules the retry with backoff
  }
}

// ---------------------------------------------------------- scheduled sweeps

/**
 * Escalate batches that have sat in one stage longer than the SLA. The UPDATE
 * ... WHERE "escalatedAt" IS NULL is atomic, so even two sweeps running at
 * once escalate each batch exactly once per stage.
 */
export async function sweepStuckBatches(now = new Date()): Promise<string[]> {
  const cutoff = new Date(now.getTime() - config.stageSlaMinutes * 60_000);
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; status: string; centreId: string; districtId: string; stageEnteredAt: Date }[]>`
      UPDATE batches b SET "escalatedAt" = ${now}
      FROM centres c
      WHERE c.id = b."centreId"
        AND b.status::text IN (${Prisma.join(PENDING_STATUSES)})
        AND b."escalatedAt" IS NULL
        AND b."stageEnteredAt" < ${cutoff}
      RETURNING b.id, b.status::text AS status, b."centreId", c."districtId", b."stageEnteredAt"`;
    for (const b of rows) {
      const waitedMinutes = Math.round((now.getTime() - b.stageEnteredAt.getTime()) / 60_000);
      await audit(tx, {
        entityType: 'batch',
        entityId: b.id,
        action: 'batch.escalated',
        details: { stage: b.status, waitedMinutes, slaMinutes: config.stageSlaMinutes },
      });
      await tx.outboxEvent.create({
        data: { type: 'batch.escalated', payload: { type: 'batch.escalated', batchId: b.id, centreId: b.centreId, districtId: b.districtId, status: b.status } },
      });
    }
    return rows.map((r) => r.id);
  });
}

/**
 * Safety net for lost queue state (e.g. Redis restarted without persistence):
 * Postgres knows which certificates still need a PDF or a message, so we
 * re-enqueue them. jobIds dedupe anything that is in fact still queued.
 */
export async function reconcilePendingCertificates(now = new Date()): Promise<number> {
  const staleBefore = new Date(now.getTime() - config.reconcileStaleAfterMs);
  const stuck = await prisma.certificate.findMany({
    where: { status: 'VALID', deliveryStatus: 'PENDING', issuedAt: { lt: staleBefore } },
    select: { id: true },
    take: 5000,
  });
  await enqueuePdf(stuck.map((c) => c.id));
  return stuck.length;
}
