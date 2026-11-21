// Batch lifecycle. Every state change runs in one Postgres transaction that
// (1) row-locks the batch, (2) re-checks the rules against the locked row,
// (3) writes the change + audit + outbox event. Concurrency safety therefore
// lives in the database, not in any single API instance's memory.
import { BatchStatus, DecisionType, Prisma } from '@prisma/client';
import { config } from '../config';
import { prisma } from '../infra';
import { conflict, forbidden, isUniqueViolation, notFound, unprocessable } from '../lib/errors';
import { newVerifyCode } from '../lib/tokens';
import { audit, emit } from './audit';
import { ValidCandidate } from './spreadsheet';
import { Actor, EDITABLE_STATUSES, resolveVotes, STAGE_OF_STATUS, whyCannotDecide } from './workflow';

type Tx = Prisma.TransactionClient;

interface LockedBatch {
  id: string;
  status: BatchStatus;
  revision: number;
  centreId: string;
  candidateCount: number;
  districtId: string;
  centreName: string;
  course: string;
}

/** SELECT ... FOR UPDATE: concurrent writers to the same batch queue up here. */
async function lockBatch(tx: Tx, batchId: string): Promise<LockedBatch> {
  const rows = await tx.$queryRaw<LockedBatch[]>`
    SELECT b.id, b.status::text AS status, b.revision, b."centreId", b."candidateCount", b.course,
           c."districtId", c.name AS "centreName"
    FROM batches b JOIN centres c ON c.id = b."centreId"
    WHERE b.id = ${batchId}
    FOR UPDATE OF b`;
  if (!rows[0]) throw notFound('Batch not found');
  return rows[0];
}

const STAGE_ORDER = { DISTRICT: 0, QUALITY: 1, STATE: 2 } as const;
const STAGE_OF_ROLE: Partial<Record<Actor['role'], keyof typeof STAGE_ORDER>> = { OFFICER: 'DISTRICT', QUALITY: 'QUALITY', STATE: 'STATE' };

/** True when the actor's own stage is already behind the batch (they were simply too late). */
function hasMovedPast(actor: Actor, batch: LockedBatch): boolean {
  const { status, districtId } = batch;
  const mine = STAGE_OF_ROLE[actor.role];
  if (!mine || (actor.role === 'OFFICER' && actor.districtId !== districtId)) return false;
  // Small batches skip the quality stage entirely: it was never Neha's step.
  if (actor.role === 'QUALITY' && batch.candidateCount < config.largeBatchThreshold) return false;
  if (status === 'APPROVED' || status === 'REJECTED' || status === 'RETURNED') return true;
  const current = STAGE_OF_STATUS[status];
  return !!current && STAGE_ORDER[current] > STAGE_ORDER[mine];
}

function assertOwnCentre(actor: Actor, batch: { centreId: string }) {
  if (actor.role !== 'CENTRE' || actor.centreId !== batch.centreId) {
    throw forbidden('Only the training centre that owns this batch can do this');
  }
}

/** Visibility rule used by both list/detail endpoints and realtime fan-out. */
export function canSeeBatch(actor: Actor, batch: { centreId: string; districtId: string }): boolean {
  switch (actor.role) {
    case 'CENTRE':
      return actor.centreId === batch.centreId;
    case 'OFFICER':
      return actor.districtId === batch.districtId;
    case 'QUALITY':
    case 'STATE':
      return true;
  }
}

export function batchVisibilityWhere(actor: Actor): Prisma.BatchWhereInput {
  switch (actor.role) {
    case 'CENTRE':
      return { centreId: actor.centreId ?? '__none__' };
    case 'OFFICER':
      return { centre: { districtId: actor.districtId ?? '__none__' } };
    default:
      return {};
  }
}

export async function createBatch(actor: Actor, input: { title: string; course: string }, requestId?: string) {
  if (actor.role !== 'CENTRE' || !actor.centreId) throw forbidden('Only training centres create batches');
  const centreId = actor.centreId;
  return prisma.$transaction(async (tx) => {
    const centre = await tx.centre.findUniqueOrThrow({ where: { id: centreId } });
    const batch = await tx.batch.create({
      data: { centreId, title: input.title, course: input.course, createdById: actor.id },
    });
    await audit(tx, { entityType: 'batch', entityId: batch.id, action: 'batch.created', actor, toStatus: 'DRAFT', requestId });
    await emit(tx, { type: 'batch.changed', batchId: batch.id, centreId, districtId: centre.districtId, status: 'DRAFT', requestId });
    return batch;
  });
}

/**
 * Replace the batch's candidate list atomically. Either every row is stored
 * or none is: validation errors and cross-batch conflicts abort before any write.
 */
export async function replaceCandidates(
  actor: Actor,
  batchId: string,
  candidates: ValidCandidate[],
  requestId?: string,
) {
  return prisma.$transaction(async (tx) => {
    const batch = await lockBatch(tx, batchId);
    assertOwnCentre(actor, batch);
    if (!EDITABLE_STATUSES.includes(batch.status)) {
      throw conflict(`Candidates can only be changed while the batch is a draft or returned (it is ${batch.status})`);
    }

    // An enrollment may be in only one live batch and certified only once.
    const enrollments = candidates.map((c) => c.enrollmentNo);
    const clashes = await tx.candidate.findMany({
      where: {
        enrollmentNo: { in: enrollments },
        batchId: { not: batchId },
        batch: { status: { not: 'REJECTED' } },
      },
      select: { enrollmentNo: true, batch: { select: { title: true } } },
    });
    if (clashes.length) {
      const byEnrollment = new Map(clashes.map((c) => [c.enrollmentNo, c.batch.title]));
      throw unprocessable(
        'Some candidates are already in another batch',
        candidates
          .filter((c) => byEnrollment.has(c.enrollmentNo))
          .map((c) => ({
            row: c.rowNumber,
            column: 'enrollment_no',
            message: `${c.enrollmentNo} is already in batch "${byEnrollment.get(c.enrollmentNo)}"`,
          })),
      );
    }

    await tx.candidate.deleteMany({ where: { batchId } });
    await tx.candidate.createMany({ data: candidates.map((c) => ({ ...c, batchId })) });
    await tx.batch.update({ where: { id: batchId }, data: { candidateCount: candidates.length } });
    await audit(tx, {
      entityType: 'batch',
      entityId: batchId,
      action: 'batch.candidates_uploaded',
      actor,
      details: { count: candidates.length, revision: batch.revision },
      requestId,
    });
    await emit(tx, { type: 'batch.changed', batchId, centreId: batch.centreId, districtId: batch.districtId, status: batch.status, requestId });
    return { count: candidates.length };
  });
}

/**
 * Submit (DRAFT) or resubmit (RETURNED). DECISION: a resubmission bumps the
 * revision and restarts at the district stage. Votes are keyed by revision, so
 * every approval given to the old list stops counting - reviewers approved a
 * different list of people, and the edit may even change whether the batch is
 * "large". Old votes stay in the audit trail.
 */
export async function submitBatch(actor: Actor, batchId: string, requestId?: string) {
  return prisma.$transaction(async (tx) => {
    const batch = await lockBatch(tx, batchId);
    assertOwnCentre(actor, batch);
    if (!EDITABLE_STATUSES.includes(batch.status)) throw conflict(`Batch is ${batch.status} and cannot be submitted`);
    if (batch.candidateCount === 0) throw unprocessable('Upload candidates before submitting');

    const isResubmit = batch.status === 'RETURNED';
    const revision = isResubmit ? batch.revision + 1 : batch.revision;
    await tx.batch.update({
      where: { id: batchId },
      data: {
        status: 'PENDING_DISTRICT',
        revision,
        stageEnteredAt: new Date(),
        escalatedAt: null,
        returnReason: null,
        returnedBy: null,
      },
    });
    await audit(tx, {
      entityType: 'batch',
      entityId: batchId,
      action: isResubmit ? 'batch.resubmitted' : 'batch.submitted',
      actor,
      fromStatus: batch.status,
      toStatus: 'PENDING_DISTRICT',
      details: isResubmit ? { revision, note: 'Approvals from earlier revisions no longer count' } : { revision },
      requestId,
    });
    await emit(tx, { type: 'batch.changed', batchId, centreId: batch.centreId, districtId: batch.districtId, status: 'PENDING_DISTRICT', requestId });
    return { status: 'PENDING_DISTRICT' as const, revision };
  });
}

export interface DecideInput {
  decision: DecisionType;
  reason?: string;
  /** The revision the reviewer was looking at. Stale views are refused. */
  revision: number;
}

export async function decide(actor: Actor, batchId: string, input: DecideInput, requestId?: string) {
  return prisma.$transaction(
    async (tx) => {
      const batch = await lockBatch(tx, batchId);
      const why = whyCannotDecide(actor, batch.status, batch.districtId);
      if (why) {
        // Distinguish "not your step" (403) from "too late, it moved on" (409):
        // an officer who loses a race against a colleague gets a 409.
        if (hasMovedPast(actor, batch)) throw conflict(`Batch has already moved on (now ${batch.status})`);
        throw forbidden(why);
      }
      if (input.revision !== batch.revision) {
        throw conflict(`You reviewed revision ${input.revision} but the batch is now at revision ${batch.revision}. Reload and review again.`);
      }
      const stage = STAGE_OF_STATUS[batch.status]!;

      try {
        await tx.decision.create({
          data: { batchId, revision: batch.revision, stage, actorId: actor.id, decision: input.decision, reason: input.reason },
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('You have already recorded a decision for this batch at this stage');
        throw err;
      }
      await audit(tx, {
        entityType: 'batch',
        entityId: batchId,
        action: `vote.${input.decision.toLowerCase()}`,
        actor,
        details: { stage, revision: batch.revision, reason: input.reason ?? null },
        requestId,
      });

      const votes = await tx.decision.findMany({
        where: { batchId, revision: batch.revision, stage },
        select: { decision: true },
      });
      const next = resolveVotes(stage, votes, batch.candidateCount);

      if (!next) {
        await emit(tx, { type: 'batch.changed', batchId, centreId: batch.centreId, districtId: batch.districtId, status: batch.status, requestId });
        return { status: batch.status, transitioned: false, votes: votes.length };
      }

      // Compare-and-set on status as a second guard on top of the row lock.
      const updated = await tx.batch.updateMany({
        where: { id: batchId, status: batch.status, revision: batch.revision },
        data: {
          status: next,
          stageEnteredAt: new Date(),
          escalatedAt: null,
          ...(next === 'RETURNED' ? { returnReason: input.reason ?? null, returnedBy: actor.name } : {}),
        },
      });
      if (updated.count !== 1) throw conflict('Batch changed while deciding; reload and try again');

      await audit(tx, {
        entityType: 'batch',
        entityId: batchId,
        action: 'batch.transitioned',
        actor,
        fromStatus: batch.status,
        toStatus: next,
        details: { stage, revision: batch.revision, decidingVotes: votes.length, reason: input.reason ?? null },
        requestId,
      });

      if (next === 'APPROVED') {
        const issued = await issueCertificates(tx, batch, actor, requestId);
        await emit(tx, { type: 'batch.approved', batchId, centreId: batch.centreId, districtId: batch.districtId, status: next, requestId });
        return { status: next, transitioned: true, certificatesIssued: issued };
      }
      await emit(tx, { type: 'batch.changed', batchId, centreId: batch.centreId, districtId: batch.districtId, status: next, requestId });
      return { status: next, transitioned: true };
    },
    { timeout: 30_000 },
  );
}

/**
 * Create one certificate row per candidate, inside the final-approval
 * transaction. Numbers come from a Postgres sequence (never reused, safe
 * across any number of API instances). Unique constraints on candidateId and
 * enrollmentNo make a second certificate for the same person impossible.
 * PDF generation and WhatsApp delivery happen later, asynchronously.
 */
async function issueCertificates(tx: Tx, batch: LockedBatch, actor: Actor, requestId?: string): Promise<number> {
  const candidates = await tx.candidate.findMany({ where: { batchId: batch.id }, orderBy: { rowNumber: 'asc' } });
  if (!candidates.length) return 0;
  const seq = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT nextval('certificate_number_seq') AS n FROM generate_series(1, ${candidates.length})`;
  const year = new Date().getUTCFullYear();
  try {
    await tx.certificate.createMany({
      data: candidates.map((c, i) => ({
        number: `${config.certificatePrefix}-${year}-${String(seq[i].n).padStart(6, '0')}`,
        verifyCode: newVerifyCode(),
        candidateId: c.id,
        enrollmentNo: c.enrollmentNo,
        batchId: batch.id,
        holderName: c.name,
        course: batch.course,
        centreName: batch.centreName,
        phone: c.phone,
      })),
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('A candidate in this batch already holds a certificate; nothing was issued');
    throw err;
  }
  await audit(tx, {
    entityType: 'batch',
    entityId: batch.id,
    action: 'certificates.issued',
    actor,
    details: { count: candidates.length },
    requestId,
  });
  return candidates.length;
}

export async function revokeCertificate(actor: Actor, certificateId: string, reason: string, requestId?: string) {
  if (actor.role !== 'STATE') throw forbidden('Only the state office can cancel certificates');
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; status: string; batchId: string; number: string }[]>`
      SELECT id, status::text AS status, "batchId", number FROM certificates WHERE id = ${certificateId} FOR UPDATE`;
    const cert = rows[0];
    if (!cert) throw notFound('Certificate not found');
    if (cert.status === 'REVOKED') throw conflict('Certificate is already cancelled');
    await tx.certificate.update({
      where: { id: certificateId },
      data: { status: 'REVOKED', revokedAt: new Date(), revokedById: actor.id, revokeReason: reason },
    });
    await audit(tx, {
      entityType: 'certificate',
      entityId: certificateId,
      batchId: cert.batchId,
      action: 'certificate.revoked',
      actor,
      fromStatus: 'VALID',
      toStatus: 'REVOKED',
      details: { reason },
      requestId,
    });
    const batch = await tx.batch.findUniqueOrThrow({ where: { id: cert.batchId }, include: { centre: true } });
    await emit(tx, {
      type: 'certificate.revoked',
      batchId: cert.batchId,
      centreId: batch.centreId,
      districtId: batch.centre.districtId,
      certificateId,
      certificateNumber: cert.number,
      requestId,
    });
    return { number: cert.number };
  });
}
