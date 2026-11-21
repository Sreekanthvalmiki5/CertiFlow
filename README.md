# CertiFlow: Skilling Certificate Issuance Platform

Training centres upload their passed batches. Officers review them, the state office gives final approval, every candidate gets a certificate on WhatsApp, and anyone can check that a certificate is genuine.

- **Run it:** `docker compose up --build`, then open http://localhost:8080 (full guide in [SETUP.md](SETUP.md))
- **Test it:** `docker compose --profile test run --rm tests` (42 automated tests)
- **Production plan:** [DEPLOYMENT.md](DEPLOYMENT.md)

---

## 1. Requirements note

### What the brief actually asks for
The brief is short and informal. Here is how I turned it into requirements.

| Brief says | Requirement I derived |
|---|---|
| "upload their passed batches" | A centre creates a batch, then uploads its existing spreadsheet (CSV or XLSX). The upload is **validated all-or-nothing**: every bad row and column is reported, and nothing is saved until the whole file is clean. |
| "District officers check them" / "more than one officer to agree" | District approval needs a **quorum of 2 different officers from the batch's own district** (configurable). |
| "big batches need extra scrutiny" | Batches of **≥ 50 candidates** (configurable) get an extra **quality team** stage between district and state. |
| "The state office has the final say" | Final approval is the state office's. Only that approval issues certificates. |
| "straight away on WhatsApp" | Approval returns at once. PDFs and WhatsApp messages are produced by background workers, retried until delivered, and each candidate gets **exactly one** message. |
| "Officers sometimes make mistakes… fix them" | (a) Reviewers can **send back** a batch with a reason, and the centre fixes and resubmits it. (b) The state office can **cancel (revoke)** a wrongly issued certificate. Votes are never edited; corrections are new, audited events. |
| "check that one is genuine" | A public `/verify` page that needs no login. It takes the certificate number **plus** an 8-character code printed on the certificate (also in its QR code). |
| "files sitting with an officer for days" | An SLA sweeper **escalates** any batch idle in one stage past the SLA. It shows up live on the state office's "Stuck batches" panel, so nobody has to chase it. |
| "nobody can say who approved what" | Every action is in an **append-only audit trail** (who, role, when, from→to status, request id). The database refuses UPDATE or DELETE on it. |

### Decisions I made where the brief was unclear
1. **What happens to earlier approvals when a batch is sent back and resent (Moment 6).** *Decision: they are discarded.* Every resubmission increases the batch's `revision`, and votes are stored per revision, so votes on revision 1 can never count towards revision 2. The resent batch starts again at the **district** stage, whoever sent it back.
   *Why:* the reviewers approved a different list of people. The edit might even push the batch over or under the "large batch" threshold. Carrying approvals forward would let unreviewed names through. The old votes stay visible (struck through) and in the audit trail.
2. **Quorum applies to approve and reject. One officer can send back.** Rejecting is final, so it is a "district decision" that needs 2 officers. Sending back does no harm (the centre just fixes it), so one officer is enough. Each officer votes once per revision and stage.
3. **A reviewer acting on an outdated screen is refused.** Every decision carries the revision the reviewer looked at. If the batch has been resent since, the decision gets a 409 "reload and review again".
4. **One certificate per enrollment number, ever.** `certificates.enrollmentNo` and `certificates.candidateId` are UNIQUE in the database. An enrollment number also can't sit in two live batches at once, which is checked at upload.
5. **Public verification shows as little as possible.** It shows a masked name (`R*** K****`), the course, the centre and the dates. It never shows the phone number, enrollment number or date of birth. A wrong code and a missing certificate get the *same* answer, so certificate numbers can't be enumerated. The endpoint is rate-limited per IP.
6. **Candidates don't log in.** WhatsApp delivers a **signed, expiring, per-certificate download link** (HMAC). A link for one certificate can't open another, and a cancelled certificate can no longer be downloaded.
7. **Sign-in is a demo persona switcher** (as the brief asks), but the server treats identity strictly. It only trusts a signed JWT, re-loads the user on every request, and **rejects** any body field such as `actorId` (strict schemas).
8. **Officers see candidate details for their own district only.** Other districts get 404 (not 403), so they can't even confirm a batch exists. Certificate contact details are visible only to the owning centre and the state office.

### What is out of scope (honest list)
Real authentication (OTP/SSO), multiple courses per candidate, editing individual candidate rows in the UI (the centre re-uploads the corrected sheet), and e-signing of PDFs. See [Known limitations](#7-known-limitations--next-steps).

---

## 2. The problems that matter most

These are the hard parts of this problem. Each one maps to a "moment that must work" and has an automated test.

| # | Problem | How it is solved | Test |
|---|---|---|---|
| 1 | **Partial uploads** | Parse → validate every row → collect *all* errors with row/column → write in **one transaction** only if there are zero errors. A bad re-upload leaves the previous good list untouched. | `moment1-upload.test.ts` |
| 2 | **Race between two officers** | Each decision runs in a DB transaction that takes `SELECT … FOR UPDATE` on the batch row, re-checks the rules on the locked row, inserts a vote (UNIQUE per officer/stage/revision) and counts votes. The status change is also a compare-and-set (`WHERE status = expected`). | `moment2-concurrency.test.ts` |
| 3 | **Exactly one WhatsApp per candidate over an unreliable provider** | Certificates are created in the approval transaction. A transactional outbox → BullMQ → PDF worker → delivery worker. Each send carries an **idempotency key** (`certificate-<id>`), so a timeout ("did it send?") is safely retried. Delivery state is a conditional update. | `moment3-delivery.test.ts` (provider set to fail 25%, throttle 5%, *deliver-then-time-out* 15%) |
| 4 | **Cancelled must never show genuine** | Revoking commits to Postgres, then **synchronously deletes** the Redis verify-cache entry. The outbox relay deletes it again as a backstop, and the cache TTL (30 s) bounds the worst case if Redis is unreachable. | `moment4-6.test.ts` |
| 5 | **Stuck files** | A BullMQ scheduled job (one run per tick across all replicas) does an atomic `UPDATE … SET escalatedAt WHERE escalatedAt IS NULL AND stageEnteredAt < now - SLA RETURNING …`, then writes an audit event and pushes a live event to the state office. | `moment4-6.test.ts` |
| 6 | **Send back → resend** | Revision-scoped votes (see decision 1). | `moment4-6.test.ts` |
| - | **Never-happen rules** | Role and stage checks, district/centre scoping, strict input schemas, pinned JWT algorithm, DB unique constraints, append-only audit trigger. | `never.test.ts` |

---

## 3. How the system is put together

```
 Browser (React + Vite)                        Employer / public            Candidate phone
   │  REST + SSE (live updates)                    │ /verify (no login)         ▲ WhatsApp
   ▼                                               ▼                            │
┌─────────────────────── nginx (frontend container) ─────────────────────┐      │
└───────────────────────────────┬────────────────────────────────────────┘      │
                                ▼                                               │
                    ┌────────────────────┐   pub/sub    ┌─────────┐             │
                    │  API (Express, TS) │◄────────────►│  Redis  │ verify cache│
                    │  stateless, N pods │              │ BullMQ  │ rate limits │
                    └─────────┬──────────┘              └────┬────┘             │
     one transaction:         │                              │ queues           │
     state change + audit     ▼                              ▼                  │
     + outbox row     ┌──────────────┐  outbox relay  ┌───────────────────┐     │
                      │  PostgreSQL  │◄──────────────►│ Worker (N pods)   │─────┘
                      │ source of    │ SKIP LOCKED    │ - outbox relay    │  idempotent send
                      │ truth        │                │ - PDF render      │  (WhatsApp stand-in)
                      └──────────────┘                │ - WhatsApp send   │
                                                      │ - SLA sweep       │
                                                      │ - reconciler      │
                                                      └───────────────────┘
```

**Containers** (`docker-compose.yml`): `postgres`, `redis` (AOF on), `migrate` (one-shot: migrations + seed), `api`, `worker` ×2, `whatsapp` (stand-in provider), `frontend` (nginx serving the Vite build and proxying `/api`).

**Flow of a batch:**
`DRAFT → PENDING_DISTRICT (2 votes) → [PENDING_QUALITY if ≥50] → PENDING_STATE → APPROVED`, and from any review stage → `RETURNED` (one reviewer, with a reason) or `REJECTED` (quorum). `RETURNED → (fix, resubmit, revision+1) → PENDING_DISTRICT`.

**Flow of a certificate:**
final approval transaction creates N certificate rows (numbers from a Postgres `SEQUENCE`) and an outbox event `batch.approved` → the relay enqueues one `pdf` job per certificate (jobId = `pdf-<id>`) → PDF written atomically (temp file + rename) → `deliver-<id>` job → WhatsApp with idempotency key → `SENT`. After 25 failed attempts (or a non-retryable 4xx) → `FAILED`, which the state office sees and can retry.

### Code map
```
backend/
  prisma/schema.prisma            data model (commented)
  prisma/migrations/              SQL migrations (+ certificate sequence, append-only audit trigger)
  prisma/seed.ts                  demo people + sample batches, created through the real services
  src/domain/workflow.ts          pure rules: who acts at which stage, quorum, next status
  src/domain/batchService.ts      transactions: upload, submit, decide (row lock), issue, revoke
  src/domain/spreadsheet.ts       CSV/XLSX parsing + per-row validation
  src/domain/verification.ts      public verify, Redis cache, rate limit
  src/domain/pdf.ts               certificate PDF with QR code
  src/domain/whatsappClient.ts    provider client (timeout, retryable vs not)
  src/jobs/                       queues, idempotent handlers, outbox relay, SLA sweep, reconciler
  src/realtime/                   Redis pub/sub → Server-Sent Events, filtered per viewer
  src/http/                       routes, auth, validation, error handling
  src/mock-whatsapp/              the unreliable WhatsApp stand-in
  tests/                          one file per "moment", plus never.test.ts
frontend/src/
  App.tsx                         persona switcher, queues, live updates
  components/BatchDetail.tsx      stepper, upload + row errors, decisions, certificates, audit trail
  components/StatePanel.tsx       stuck batches, certificate search/cancel
  pages/Verify.tsx, Phone.tsx     public verification, demo candidate inbox
```

---

## 4. Key technical decisions (and why)

| Choice | Why | Alternative considered |
|---|---|---|
| **Postgres row locks + unique constraints** for correctness | Correctness has to hold across many API instances. Only the database sees every writer, so the database is the referee. | Redis locks (Redlock): another failure mode, and they don't survive Redis restarts. |
| **Transactional outbox** (table + relay with `FOR UPDATE SKIP LOCKED`) | "Commit the decision" and "publish the event" can't drift apart. If a process dies between them, the event is still in the table and gets relayed. Several relays can run in parallel without double work. | Publishing to the queue straight after commit loses events on a crash. |
| **BullMQ on Redis** as the queue/broker | Redis is already required (cache). BullMQ gives retries with exponential backoff, a **global rate limiter** (stays under WhatsApp's messages/sec at peak), job-id de-duplication and scheduled jobs that run once across replicas. | RabbitMQ/Kafka: one more stateful system to run, without enough benefit at 30k jobs/hour. |
| **Idempotent handlers everywhere** | At-least-once delivery is the realistic guarantee, so every step is safe to repeat: PDF render is deterministic and overwrites the same file; the send carries an idempotency key; status flips are conditional updates. | Chasing exactly-once in the broker, which doesn't exist end to end. |
| **Reconciler from Postgres** | If Redis loses its queues (restart without AOF), a sweep finds certificates still `PENDING` and enqueues them again. Postgres is the only source of truth. | Relying on Redis durability alone. |
| **Redis for verification cache + rate limit** | Public lookups come in bursts. A short TTL cache takes load off Postgres, and revocation evicts the entry right away. | No cache: fine at low volume, but bursts hit the DB directly. |
| **SSE over Redis pub/sub** for "see changes without refreshing" | One-way server→browser updates are all we need. It works through plain HTTP and nginx, and pub/sub lets *any* API instance push to its own clients. Events carry ids only; clients re-fetch what their role may see. | WebSockets: two-way channel not needed. Polling: wasteful and slow. |
| **Verification needs number + code** | Stops enumeration and scraping of certificate numbers. The code is printed on the PDF and embedded in the QR. | Number only: anyone could walk the sequence. |
| **Append-only audit enforced by a DB trigger** | "Who decided what and when" must hold even against a buggy code path. | App-level discipline only. |
| **Prisma** with checked-in SQL migrations | Typed queries. Raw SQL is used where it matters (`FOR UPDATE`, `SKIP LOCKED`, sequences, atomic `UPDATE … RETURNING`). | Drizzle: equally fine. |

**Observability:** every request gets an `x-request-id`, which is stored on every audit row and passed into the background jobs it causes. So a certificate's history (`issued → pdf_generated → delivered`) can be traced back to the exact approval request. Logs are structured JSON (pino) and never contain tokens or query strings. `GET /api/batches/:id/timeline` and `GET /api/certificates/:id/timeline` show the end-to-end trail, and the UI has an "audit trail" view.

---

## 5. Demo walkthrough

Open http://localhost:8080 and pick a person. Each browser tab keeps its own sign-in, so open two tabs side by side to watch live updates.

1. **Anika (centre):** "+ New batch" → upload `bad_batch.csv` (sample link in the upload box) → see the exact row and column errors, with *nothing saved* → upload `good_batch_60.csv` → Submit.
2. **Dev** and **Meera (officers):** approve. The batch moves to the **quality team** (60 ≥ 50). Kabir arriving late gets "already moved on".
3. **Neha (quality)** approves → **Farah (state)** approves → watch the delivered count rise live as the flaky WhatsApp stand-in fails and gets retried.
4. Open **/phone** and enter a candidate's number (e.g. `+919700000000`): exactly one message with a PDF link.
5. **Farah:** copy a certificate number. The verification code is on the PDF; for seeded data, the PDF is linked from /phone. Check it on **/verify** (genuine) → cancel it in Farah's certificate list → check again: **"No longer valid"**.
6. **Farah's** home shows **Stuck batches**: the seeded "Welding - Nov cohort" was escalated automatically.
7. **Send back:** Meera sends back "Retail Sales - Feb cohort" with a reason → Anika re-uploads and resubmits → Dev's earlier approval is struck through and no longer counts.

---

## 6. Tests

`docker compose --profile test run --rm tests` (or `cd backend && npm test` against the compose DB; see SETUP.md). They run against **real Postgres and Redis** and the **real queue pipeline**. They mock only the WhatsApp provider, and that mock is deliberately unreliable.

| File | Proves |
|---|---|
| `unit.test.ts` | validation rules, quorum/stage logic, token signing, name masking |
| `moment1-upload.test.ts` | bad rows reported precisely, nothing saved, previous list intact, XLSX supported, cross-batch duplicates refused |
| `moment2-concurrency.test.ts` | 2 simultaneous approvals → 1 transition; 3 racing → 2 votes + 409; double-click → 1 vote; double final approval → certificates issued once |
| `moment3-delivery.test.ts` | 60 candidates → 60 messages, 1 per phone, 60 unique numbers, despite failures/timeouts; replaying all events and jobs sends nothing extra |
| `moment4-6.test.ts` | revoke shows on the next verify (cache warmed first); revoked PDFs can't be downloaded; no PII in verification; no enumeration; SLA escalation exactly once, even with racing sweepers; resubmission resets approvals; stale revision refused; reasons required |
| `never.test.ts` | forged/unsigned/missing tokens; identity spoofing via body; wrong role/stage; other district/centre isolation; only state revokes; one certificate per candidate (app + DB); forged download links; officers can't see contact details; every decision traceable; audit can't be edited |

---

## 7. Known limitations & next steps
- **Auth is a demo switcher.** Production needs OTP for centres, SSO for officials, and short-lived tokens with refresh.
- **PDFs are on a shared Docker volume.** Production should use object storage (S3/GCS) with private buckets and signed URLs (see DEPLOYMENT.md).
- **The WhatsApp stand-in supports an `Idempotency-Key`.** Some real WhatsApp providers don't. There we'd attach our certificate id as the message's client reference and look up its status before any retry; the "deliver-then-timeout" case is otherwise ambiguous.
- **No metrics endpoint yet** (Prometheus queue depth, delivery latency). Logs and the audit trail are the current observability.
- **The SLA is one number for every stage.** It could be configured per stage, with a reminder to the officer before escalating to the state office.
- **Escalation notifies through the live dashboard only.** No email or SMS to the senior officer yet.
- The UI uses `prompt()` for revoke reasons, and the frontend has no automated tests yet. Backend rules are where the tests are concentrated.
- **Candidate list re-upload replaces the whole list.** There is no row-level editing.

---

## 8. AI usage
I used **Claude Code (Claude Opus)** as a pair programmer throughout:
- **Where:** breaking the brief into requirements, scaffolding (Prisma schema, Express routes, React components), first drafts of tests, and the README and deployment docs.
- **How I checked it:** every "moment" and "never" rule has an integration test against real Postgres and Redis, and I ran the full suite repeatedly to catch flakiness. The tests caught real issues along the way. For example, a quality-team user voting on a small batch first got a 409 "moved on" instead of a 403 "not your step", and vitest's thread pool crashed with Prisma's native engine (fixed by switching to process forks). I reviewed the concurrency-critical code by hand (row locks, unique constraints, conditional updates, outbox transaction boundaries). I also checked that every decision listed above is enforced on the server, not just hidden in the UI.
