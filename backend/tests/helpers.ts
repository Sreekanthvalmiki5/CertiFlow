import request from 'supertest';
import { createApp } from '../src/app';
import { prisma, redis } from '../src/infra';
import { signSession } from '../src/lib/tokens';
import { demoCandidates, seedReferenceData } from '../prisma/seed';

export const app = createApp();
export const api = () => request(app);

export const auth = (userId: string) => ({ Authorization: `Bearer ${signSession(userId)}` });

/** Wipe all data (TRUNCATE bypasses the append-only audit trigger by design). */
export async function resetAll() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE audit_events, outbox_events, certificates, decisions, candidates, batches, users, centres, districts RESTART IDENTITY CASCADE',
  );
  await redis.flushdb();
  await seedReferenceData();
}

export function csvFor(prefix: string, count: number, phoneStart = 9000000000): string {
  const rows = demoCandidates(prefix, count, phoneStart).map(
    (c) => `${c.name},${c.enrollmentNo},${c.phone.slice(3)},${c.dateOfBirth.toISOString().slice(0, 10)},${c.grade}`,
  );
  return ['name,enrollment_no,phone,date_of_birth,grade', ...rows].join('\n');
}

export async function createBatch(title = 'Test batch', userId = 'anika'): Promise<string> {
  const res = await api().post('/api/batches').set(auth(userId)).send({ title, course: 'Test Course L3' });
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id;
}

export async function uploadCsv(batchId: string, csv: string, userId = 'anika') {
  return api().post(`/api/batches/${batchId}/candidates`).set(auth(userId)).attach('file', Buffer.from(csv), 'candidates.csv');
}

/** Create + upload + submit a batch; returns its id (status PENDING_DISTRICT). */
export async function submittedBatch(count: number, prefix = 'TST', phoneStart = 9000000000): Promise<string> {
  const id = await createBatch(`Batch ${prefix}`);
  const up = await uploadCsv(id, csvFor(prefix, count, phoneStart));
  if (up.status !== 200) throw new Error(`upload failed: ${JSON.stringify(up.body)}`);
  const sub = await api().post(`/api/batches/${id}/submit`).set(auth('anika'));
  if (sub.status !== 200) throw new Error(`submit failed: ${JSON.stringify(sub.body)}`);
  return id;
}

export function vote(batchId: string, userId: string, decision = 'APPROVE', revision = 1, reason?: string) {
  return api().post(`/api/batches/${batchId}/decisions`).set(auth(userId)).send({ decision, revision, reason });
}

/** Drive a batch all the way to APPROVED through the real API. */
export async function approveFully(batchId: string, large: boolean) {
  for (const u of ['dev', 'meera']) expectOk(await vote(batchId, u));
  if (large) expectOk(await vote(batchId, 'neha'));
  expectOk(await vote(batchId, 'farah'));
}

function expectOk(res: request.Response) {
  if (res.status !== 200) throw new Error(`vote failed: ${res.status} ${JSON.stringify(res.body)}`);
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 60_000, stepMs = 100): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
