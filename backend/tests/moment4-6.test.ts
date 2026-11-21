// Moment 4: a cancelled certificate is reported invalid on the next check.
// Moment 5: a stuck batch is escalated without anyone chasing it.
// Moment 6: send back -> fix -> resend, with a deliberate rule for old approvals.
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/infra';
import { sweepStuckBatches } from '../src/jobs/handlers';
import { signDownloadToken } from '../src/lib/tokens';
import { writeCertificatePdf } from '../src/domain/pdf';
import { api, approveFully, auth, csvFor, resetAll, submittedBatch, uploadCsv, vote } from './helpers';

describe('Moment 4 - cancelling a fake certificate', () => {
  beforeEach(resetAll);

  it('an employer checking right after cancellation is told it is no longer valid', async () => {
    const batchId = await submittedBatch(2, 'REV');
    await approveFully(batchId, false);
    const cert = await prisma.certificate.findFirstOrThrow({ where: { batchId } });
    const check = () => api().get('/api/public/verify').query({ n: cert.number, c: cert.verifyCode });

    const before = await check(); // also warms the Redis cache
    expect(before.body.result).toBe('VALID');

    const revoke = await api().post(`/api/certificates/${cert.id}/revoke`).set(auth('farah')).send({ reason: 'Issued from a forged attendance sheet' });
    expect(revoke.status).toBe(200);

    const after = await check();
    expect(after.body.result).toBe('REVOKED');
    expect(after.body.revokedAt).toBeTruthy();

    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: cert.id, action: 'certificate.revoked' } });
    expect(audit.actorId).toBe('farah');
  });

  it('a cancelled certificate can no longer be downloaded either', async () => {
    const batchId = await submittedBatch(1, 'REVDL');
    await approveFully(batchId, false);
    const cert = await prisma.certificate.findFirstOrThrow({ where: { batchId } });
    const pdfPath = await writeCertificatePdf(cert);
    await prisma.certificate.update({ where: { id: cert.id }, data: { pdfPath } });
    const url = `/api/public/certificates/${cert.id}/download?t=${signDownloadToken(cert.id)}`;
    expect((await api().get(url)).status).toBe(200);
    await api().post(`/api/certificates/${cert.id}/revoke`).set(auth('farah')).send({ reason: 'Fraudulent' });
    expect((await api().get(url)).status).toBe(403);
  });

  it('verification shows no personal details and gives nothing away for a wrong code', async () => {
    const batchId = await submittedBatch(1, 'PRIV', 9811111111);
    await approveFully(batchId, false);
    const cert = await prisma.certificate.findFirstOrThrow({ where: { batchId } });
    const ok = await api().get('/api/public/verify').query({ n: cert.number, c: cert.verifyCode });
    const body = JSON.stringify(ok.body);
    expect(body).not.toContain('9811111111');
    expect(body).not.toContain(cert.enrollmentNo);
    expect(body).not.toContain(cert.holderName); // masked
    const wrong = await api().get('/api/public/verify').query({ n: cert.number, c: 'WRONGCODE' });
    expect(wrong.body).toEqual({ result: 'NOT_FOUND' });
    const missing = await api().get('/api/public/verify').query({ n: 'PSM-2026-999999', c: 'WRONGCODE' });
    expect(missing.body).toEqual(wrong.body); // indistinguishable: no enumeration
  });
});

describe('Moment 5 - stuck batches escalate automatically', () => {
  beforeEach(resetAll);

  it('a batch idle past the SLA is escalated once and shows up for the state office', async () => {
    const stuck = await submittedBatch(3, 'STK');
    const fresh = await submittedBatch(3, 'FRS', 9100000000);
    await prisma.batch.update({ where: { id: stuck }, data: { stageEnteredAt: new Date(Date.now() - 3 * 3600_000) } });

    // Two sweeps racing (two worker replicas) still escalate exactly once.
    const [a, b] = await Promise.all([sweepStuckBatches(), sweepStuckBatches()]);
    expect([...a, ...b]).toEqual([stuck]);
    expect(await sweepStuckBatches()).toEqual([]);

    const events = await prisma.auditEvent.findMany({ where: { batchId: stuck, action: 'batch.escalated' } });
    expect(events).toHaveLength(1);
    expect(await prisma.auditEvent.count({ where: { batchId: fresh, action: 'batch.escalated' } })).toBe(0);

    const list = await api().get('/api/escalations').set(auth('farah'));
    expect(list.body.map((x: { id: string }) => x.id)).toEqual([stuck]);
    expect((await api().get('/api/escalations').set(auth('dev'))).status).toBe(403);
  });

  it('acting on the batch clears the escalation for the next stage', async () => {
    const stuck = await submittedBatch(3, 'STK2');
    await prisma.batch.update({ where: { id: stuck }, data: { stageEnteredAt: new Date(Date.now() - 3 * 3600_000) } });
    await sweepStuckBatches();
    await vote(stuck, 'dev');
    await vote(stuck, 'meera');
    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: stuck } });
    expect(batch.status).toBe('PENDING_STATE');
    expect(batch.escalatedAt).toBeNull();
  });
});

describe('Moment 6 - send back, fix and resend', () => {
  beforeEach(resetAll);

  it('resubmission starts a new revision and earlier approvals no longer count', async () => {
    const batchId = await submittedBatch(4, 'SB');
    expect((await vote(batchId, 'dev')).status).toBe(200);
    const back = await vote(batchId, 'meera', 'SEND_BACK', 1, 'Row 3 has the wrong date of birth');
    expect(back.body.status).toBe('RETURNED');

    const returned = await api().get(`/api/batches/${batchId}`).set(auth('anika'));
    expect(returned.body.returnReason).toBe('Row 3 has the wrong date of birth');

    expect((await uploadCsv(batchId, csvFor('SB', 4))).status).toBe(200);
    const resub = await api().post(`/api/batches/${batchId}/submit`).set(auth('anika'));
    expect(resub.body).toEqual({ status: 'PENDING_DISTRICT', revision: 2 });

    // Dev's revision-1 approval does not carry over: one new approval is not enough.
    expect((await vote(batchId, 'dev', 'APPROVE', 2)).body.transitioned).toBe(false);
    expect((await vote(batchId, 'kabir', 'APPROVE', 2)).body.status).toBe('PENDING_STATE');

    // The full history is kept and labelled.
    const decisions = await prisma.decision.findMany({ where: { batchId } });
    expect(decisions.filter((d) => d.revision === 1)).toHaveLength(2);
    expect(decisions.filter((d) => d.revision === 2)).toHaveLength(2);
  });

  it('a reviewer acting on the old version of a resent batch is refused', async () => {
    const batchId = await submittedBatch(2, 'SB2');
    await vote(batchId, 'meera', 'SEND_BACK', 1, 'Please fix names');
    await api().post(`/api/batches/${batchId}/submit`).set(auth('anika'));
    const stale = await vote(batchId, 'dev', 'APPROVE', 1);
    expect(stale.status).toBe(409);
    expect(stale.body.error.message).toMatch(/revision 1.*revision 2/);
  });

  it('sending back or rejecting requires a reason', async () => {
    const batchId = await submittedBatch(2, 'SB3');
    expect((await vote(batchId, 'dev', 'SEND_BACK')).status).toBe(400);
    expect((await vote(batchId, 'dev', 'REJECT')).status).toBe(400);
  });
});
