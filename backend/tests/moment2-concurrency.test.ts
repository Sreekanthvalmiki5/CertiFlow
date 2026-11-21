// Moment 2: two district officers approve the same batch at the same moment.
// The batch moves forward once, not twice.
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/infra';
import { resetAll, submittedBatch, vote } from './helpers';

async function transitions(batchId: string) {
  return prisma.auditEvent.findMany({ where: { batchId, action: 'batch.transitioned' } });
}

describe('Moment 2 - simultaneous approvals', () => {
  beforeEach(resetAll);

  it('two officers approving at once move the batch forward exactly once', async () => {
    const batchId = await submittedBatch(5);
    const [a, b] = await Promise.all([vote(batchId, 'dev'), vote(batchId, 'meera')]);
    expect([a.status, b.status]).toEqual([200, 200]);

    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.status).toBe('PENDING_STATE');
    expect(await transitions(batchId)).toHaveLength(1);
    expect([a.body.transitioned, b.body.transitioned].filter(Boolean)).toHaveLength(1);
  });

  it('a third officer racing in gets a clear "already moved on" and changes nothing', async () => {
    const batchId = await submittedBatch(5);
    const results = await Promise.all(['dev', 'meera', 'kabir'].map((u) => vote(batchId, u)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 409]);
    expect(await transitions(batchId)).toHaveLength(1);
    expect(await prisma.decision.count({ where: { batchId } })).toBe(2);
  });

  it('a double-click by the same officer records one vote', async () => {
    const batchId = await submittedBatch(5);
    const results = await Promise.all([vote(batchId, 'dev'), vote(batchId, 'dev'), vote(batchId, 'dev')]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    expect(await prisma.decision.count({ where: { batchId } })).toBe(1);
    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.status).toBe('PENDING_DISTRICT'); // one person is not a quorum
  });

  it('concurrent final approvals issue certificates once', async () => {
    const batchId = await submittedBatch(4);
    await vote(batchId, 'dev');
    await vote(batchId, 'meera');
    // The state office double-submits the final approval.
    const results = await Promise.all([vote(batchId, 'farah'), vote(batchId, 'farah')]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await prisma.certificate.count({ where: { batchId } })).toBe(4);
  });
});
