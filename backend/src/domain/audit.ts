// Audit + outbox helpers. Both are always written inside the caller's DB
// transaction so the record of a decision can never diverge from the decision.
import { Prisma } from '@prisma/client';
import type { Actor } from './workflow';

type Tx = Prisma.TransactionClient;

export interface AuditInput {
  entityType: 'batch' | 'certificate';
  entityId: string;
  batchId?: string;
  action: string;
  actor?: Actor | null;
  fromStatus?: string | null;
  toStatus?: string | null;
  details?: Prisma.InputJsonValue;
  requestId?: string;
}

export async function audit(tx: Tx, input: AuditInput) {
  await tx.auditEvent.create({
    data: {
      entityType: input.entityType,
      entityId: input.entityId,
      batchId: input.batchId ?? (input.entityType === 'batch' ? input.entityId : undefined),
      action: input.action,
      actorId: input.actor?.id,
      actorRole: input.actor?.role,
      fromStatus: input.fromStatus ?? undefined,
      toStatus: input.toStatus ?? undefined,
      details: input.details,
      requestId: input.requestId,
    },
  });
}

export type DomainEventType =
  | 'batch.changed'
  | 'batch.approved'
  | 'batch.escalated'
  | 'certificate.revoked';

export interface DomainEvent {
  type: DomainEventType;
  batchId: string;
  centreId: string;
  districtId: string;
  status?: string;
  certificateId?: string;
  certificateNumber?: string;
  requestId?: string;
}

export async function emit(tx: Tx, event: DomainEvent) {
  await tx.outboxEvent.create({ data: { type: event.type, payload: event as unknown as Prisma.InputJsonValue } });
}
