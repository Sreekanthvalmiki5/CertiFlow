// Demo for Moment 2: officers approving the SAME batch at the SAME moment.
// Humans can't click within the same millisecond, so this script fires the
// requests in parallel (Promise.all) against the running system.
//
// Usage (from the repo root, with the stack running):
//   node backend/scripts/race-approve.mjs                 -> creates a fresh 5-candidate batch and races Dev + Meera + Kabir
//   node backend/scripts/race-approve.mjs "Welding"       -> races on an existing batch whose title contains "Welding"
//   API=http://localhost:8080/api node backend/scripts/race-approve.mjs

const API = process.env.API ?? 'http://localhost:8080/api';
const OFFICERS = ['dev', 'meera', 'kabir'];

async function call(method, path, token, body, isForm = false) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  if (body && !isForm) headers['content-type'] = 'application/json';
  const res = await fetch(`${API}${path}`, { method, headers, body: isForm ? body : body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

const login = async (userId) => (await call('POST', '/auth/demo-login', null, { userId })).body.token;

async function freshBatch(anika) {
  const stamp = Date.now().toString(36).toUpperCase();
  const created = await call('POST', '/batches', anika, { title: `Race demo ${stamp}`, course: 'Race Demo Course (NSQF L3)' });
  const rows = ['name,enrollment_no,phone,date_of_birth,grade'];
  for (let i = 1; i <= 5; i++) rows.push(`Race Candidate ${'ABCDE'[i - 1]},RACE-${stamp}-${i},98${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')},2001-01-0${i},A`);
  const form = new FormData();
  form.append('file', new Blob([rows.join('\n')], { type: 'text/csv' }), 'race.csv');
  const up = await call('POST', `/batches/${created.body.id}/candidates`, anika, form, true);
  if (up.status !== 200) throw new Error(`upload failed: ${JSON.stringify(up.body)}`);
  await call('POST', `/batches/${created.body.id}/submit`, anika);
  return created.body.id;
}

async function main() {
  const titleFilter = process.argv[2];
  const [anika, farah, ...tokens] = await Promise.all(['anika', 'farah', ...OFFICERS].map(login));

  let batchId;
  if (titleFilter) {
    const list = (await call('GET', '/batches', farah)).body;
    const match = list.find((b) => b.title.toLowerCase().includes(titleFilter.toLowerCase()) && b.status === 'PENDING_DISTRICT');
    if (!match) throw new Error(`No batch waiting for district approval whose title contains "${titleFilter}"`);
    batchId = match.id;
  } else {
    batchId = await freshBatch(anika);
  }

  const before = (await call('GET', `/batches/${batchId}`, farah)).body;
  console.log(`\nBatch: "${before.title}"  status=${before.status}  revision=${before.revision}`);
  console.log(`Firing ${OFFICERS.length} approvals at the same instant (${OFFICERS.join(', ')})...\n`);

  const results = await Promise.all(
    tokens.map((t) => call('POST', `/batches/${batchId}/decisions`, t, { decision: 'APPROVE', revision: before.revision })),
  );
  results.forEach((r, i) => {
    const outcome = r.status === 200 ? `vote recorded${r.body.transitioned ? ' -> MOVED THE BATCH to ' + r.body.status : ' (waiting for quorum)'}` : r.body.error.message;
    console.log(`  ${OFFICERS[i].padEnd(6)} HTTP ${r.status}  ${outcome}`);
  });

  const after = (await call('GET', `/batches/${batchId}`, farah)).body;
  const timeline = (await call('GET', `/batches/${batchId}/timeline`, farah)).body;
  const transitions = timeline.filter((e) => e.action === 'batch.transitioned' && e.fromStatus === 'PENDING_DISTRICT');
  console.log(`\nFinal status: ${after.status}`);
  console.log(`District approvals stored: ${after.decisions.filter((d) => d.current && d.stage === 'DISTRICT').length}`);
  console.log(`Times the batch moved forward from district: ${transitions.length}  ${transitions.length === 1 ? '(correct: exactly once)' : '(WRONG)'}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
