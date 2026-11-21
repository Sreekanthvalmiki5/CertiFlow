// Pure workflow rules: who may act at which stage, and what a vote does.
// No I/O here, so every rule is unit-testable and reviewable in one place.
import { BatchStatus, DecisionType, Role, Stage } from '@prisma/client';
import { config } from '../config';

export interface Actor {
  id: string;
  name: string;
  role: Role;
  districtId: string | null;
  centreId: string | null;
}

export const STAGE_OF_STATUS: Partial<Record<BatchStatus, Stage>> = {
  PENDING_DISTRICT: 'DISTRICT',
  PENDING_QUALITY: 'QUALITY',
  PENDING_STATE: 'STATE',
};

export const PENDING_STATUSES: BatchStatus[] = ['PENDING_DISTRICT', 'PENDING_QUALITY', 'PENDING_STATE'];

const ROLE_FOR_STAGE: Record<Stage, Role> = {
  DISTRICT: 'OFFICER',
  QUALITY: 'QUALITY',
  STATE: 'STATE',
};

/** How many matching votes a stage needs before the decision takes effect. */
export function quorumFor(stage: Stage, decision: DecisionType): number {
  // SEND_BACK is non-destructive (the centre just fixes and resends), so one
  // reviewer is enough. APPROVE and REJECT are "district decisions" and need
  // agreement from more than one district officer.
  if (decision === 'SEND_BACK') return 1;
  return stage === 'DISTRICT' ? config.districtQuorum : 1;
}

/**
 * Can this actor vote on a batch in this status? Returns a reason string when
 * not allowed (so the API can say why), or null when allowed.
 */
export function whyCannotDecide(actor: Actor, status: BatchStatus, batchDistrictId: string): string | null {
  const stage = STAGE_OF_STATUS[status];
  if (!stage) return `Batch is ${status}; no decision is pending`;
  if (actor.role !== ROLE_FOR_STAGE[stage]) {
    return `The ${stage.toLowerCase()} stage belongs to ${ROLE_FOR_STAGE[stage].toLowerCase()} users, not ${actor.role.toLowerCase()}`;
  }
  if (stage === 'DISTRICT' && actor.districtId !== batchDistrictId) {
    return 'This batch belongs to a different district';
  }
  return null;
}

/** Where a batch goes once a stage reaches an approving quorum. */
export function nextStatusAfterApproval(stage: Stage, candidateCount: number): BatchStatus {
  if (stage === 'DISTRICT') {
    return candidateCount >= config.largeBatchThreshold ? 'PENDING_QUALITY' : 'PENDING_STATE';
  }
  if (stage === 'QUALITY') return 'PENDING_STATE';
  return 'APPROVED';
}

/** Outcome of counting votes after a new vote is recorded. */
export function resolveVotes(
  stage: Stage,
  votes: { decision: DecisionType }[],
  candidateCount: number,
): BatchStatus | null {
  const count = (d: DecisionType) => votes.filter((v) => v.decision === d).length;
  if (count('SEND_BACK') >= quorumFor(stage, 'SEND_BACK')) return 'RETURNED';
  if (count('REJECT') >= quorumFor(stage, 'REJECT')) return 'REJECTED';
  if (count('APPROVE') >= quorumFor(stage, 'APPROVE')) return nextStatusAfterApproval(stage, candidateCount);
  return null; // still waiting for more votes
}

/** Batches a centre user may edit (candidate upload) and submit. */
export const EDITABLE_STATUSES: BatchStatus[] = ['DRAFT', 'RETURNED'];
