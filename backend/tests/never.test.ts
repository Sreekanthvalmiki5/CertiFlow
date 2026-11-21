// "Things that must never happen".
import jwt from 'jsonwebtoken';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/infra';
import { api, approveFully, auth, createBatch, csvFor, resetAll, submittedBatch, uploadCsv, vote } from './helpers';

describe('never: acting at a step that is not yours, or as someone else', () => {
  beforeEach(resetAll);

  it('rejects missing, forged and unsigned tokens', async () => {
    expect((await api().get('/api/batches')).status).toBe(401);
    const forged = jwt.sign({ sub: 'farah' }, 'not-the-secret', { issuer: 'certiflow' });
    expect((await api().get('/api/batches').set({ Authorization: `Bearer ${forged}` })).status).toBe(401);
    const unsigned = jwt.sign({ sub: 'farah', iss: 'certiflow' }, '', { algorithm: 'none' });
    expect((await api().get('/api/batches').set({ Authorization: `Bearer ${unsigned}` })).status).toBe(401);
  });

  it('ignores attempts to claim another identity in the request body', async () => {
    const batchId = await submittedBatch(2);
    const res = await api()
      .post(`/api/batches/${batchId}/decisions`)
      .set(auth('dev'))
      .send({ decision: 'APPROVE', revision: 1, actorId: 'meera' });
    expect(res.status).toBe(400); // unknown fields are refused, not silently used
    expect(await prisma.decision.count()).toBe(0);
  });

  it('each role can only act at its own stage', async () => {
    const batchId = await submittedBatch(3);
    expect((await vote(batchId, 'anika')).status).toBe(403); // centre cannot approve
    expect((await vote(batchId, 'neha')).status).toBe(403); // quality not at district stage
    expect((await vote(batchId, 'farah')).status).toBe(403); // state cannot skip the district
    await vote(batchId, 'dev');
    await vote(batchId, 'meera');
    expect((await vote(batchId, 'neha')).status).toBe(403); // small batch: no quality stage
    expect(await prisma.decision.count({ where: { batchId } })).toBe(2);
  });

  it('officers from another district cannot see or act on a batch', async () => {
    const batchId = await submittedBatch(2);
    expect((await api().get(`/api/batches/${batchId}`).set(auth('ravi'))).status).toBe(404);
    expect((await vote(batchId, 'ravi')).status).toBe(404);
    const list = await api().get('/api/batches').set(auth('ravi'));
    expect(list.body).toEqual([]);
  });

  it('a centre cannot see or change another centre\'s batch', async () => {
    const batchId = await createBatch();
    expect((await api().get(`/api/batches/${batchId}`).set(auth('ishaan'))).status).toBe(404);
    expect((await uploadCsv(batchId, csvFor('X', 2), 'ishaan')).status).toBe(404);
    expect((await api().post(`/api/batches/${batchId}/submit`).set(auth('ishaan'))).status).toBe(404);
  });

  it('only the state office can cancel certificates', async () => {
    const batchId = await submittedBatch(1);
    await approveFully(batchId, false);
    const cert = await prisma.certificate.findFirstOrThrow();
    for (const u of ['anika', 'dev', 'neha']) {
      expect((await api().post(`/api/certificates/${cert.id}/revoke`).set(auth(u)).send({ reason: 'trying it on' })).status).toBe(403);
    }
  });

  it('a centre cannot edit a batch once it is under review', async () => {
    const batchId = await submittedBatch(2);
    expect((await uploadCsv(batchId, csvFor('LATE', 2))).status).toBe(409);
  });
});

describe('never: two certificates for one candidate, or a shared number', () => {
  beforeEach(resetAll);

  it('a certified enrollment can never enter another batch', async () => {
    const first = await submittedBatch(2, 'ONCE');
    await approveFully(first, false);
    const second = await createBatch('Again');
    const res = await uploadCsv(second, csvFor('ONCE', 2));
    expect(res.status).toBe(422);
  });

  it('the database itself refuses a duplicate certificate or number', async () => {
    const batchId = await submittedBatch(1, 'DB');
    await approveFully(batchId, false);
    const cert = await prisma.certificate.findFirstOrThrow();
    const { id: _id, ...copy } = cert;
    await expect(prisma.certificate.create({ data: { ...copy, number: 'PSM-OTHER' } })).rejects.toThrow(/Unique constraint/);
    const cand = await prisma.candidate.create({
      data: { batchId, rowNumber: 99, name: 'X Y', enrollmentNo: 'OTHER-1', phone: '+919999999999', dateOfBirth: new Date('2000-01-01'), grade: 'A' },
    });
    await expect(
      prisma.certificate.create({ data: { ...copy, candidateId: cand.id, enrollmentNo: 'OTHER-1' } }),
    ).rejects.toThrow(/Unique constraint/);
  });
});

describe('never: a stranger getting someone else\'s certificate', () => {
  beforeEach(resetAll);

  it('download links cannot be forged or reused for another certificate', async () => {
    const batchId = await submittedBatch(2);
    await approveFully(batchId, false);
    const [a, b] = await prisma.certificate.findMany();
    const { signDownloadToken } = await import('../src/lib/tokens');
    const tokenForA = signDownloadToken(a.id);
    expect((await api().get(`/api/public/certificates/${b.id}/download?t=${tokenForA}`)).status).toBe(403);
    expect((await api().get(`/api/public/certificates/${a.id}/download?t=123.abc`)).status).toBe(403);
    expect((await api().get(`/api/public/certificates/${a.id}/download`)).status).toBe(403);
  });

  it('officers do not get certificate contact details', async () => {
    const batchId = await submittedBatch(1);
    await approveFully(batchId, false);
    const res = await api().get(`/api/batches/${batchId}`).set(auth('dev'));
    expect(res.body.certificates).toEqual([]);
  });
});

describe('never: an untraceable decision', () => {
  beforeEach(resetAll);

  it('every decision is in the audit trail with who and when', async () => {
    const batchId = await submittedBatch(2);
    await approveFully(batchId, false);
    const events = await prisma.auditEvent.findMany({ where: { batchId }, orderBy: { id: 'asc' } });
    const decisions = events.filter((e) => e.action.startsWith('vote.') || e.action === 'batch.transitioned' || e.action.startsWith('batch.s'));
    // submitted + 3 votes (Dev, Meera, Farah) + 2 stage transitions
    expect(decisions).toHaveLength(6);
    for (const e of decisions) {
      expect(e.actorId).toBeTruthy();
      expect(e.createdAt).toBeInstanceOf(Date);
      expect(e.requestId).toBeTruthy();
    }
    const timeline = await api().get(`/api/batches/${batchId}/timeline`).set(auth('farah'));
    expect(timeline.body.map((e: { actorName: string }) => e.actorName)).toEqual(expect.arrayContaining(['Anika', 'Dev', 'Meera', 'Farah']));
  });

  it('the audit trail cannot be edited or deleted', async () => {
    const batchId = await createBatch();
    await expect(prisma.auditEvent.updateMany({ where: { batchId }, data: { actorId: 'someone-else' } })).rejects.toThrow(/append-only/);
    await expect(prisma.auditEvent.deleteMany({ where: { batchId } })).rejects.toThrow(/append-only/);
  });
});
