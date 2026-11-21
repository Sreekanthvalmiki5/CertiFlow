# CertiFlow: production deployment plan

## Load we are planning for
| | Volume | Rate |
|---|---|---|
| Registered users | 100,000 (mostly candidates, who never log in) | - |
| Daily active staff/centre users | ~10,000 | ~5-20 req/s at office-hours peak |
| **Results day peak** | 500 batches approved in 1 hour → **30,000 PDFs + 30,000 WhatsApp messages** | **~8.3 PDFs/s and ~8.3 msgs/s** sustained, with bursts much higher |
| Public verification | thousands/day, bursty (employer drives, social sharing) | design for 200 req/s bursts |

The heavy work is asynchronous. The API only has to commit 500 approval transactions in an hour, which is trivial. Each one creates ~60 certificate rows plus one outbox row. Everything else is queued work that we can scale and pace on our own terms.

## 1. Architecture

```
                     ┌──────────── CloudFront (CDN) ─────────────┐
 Staff / centres ───►│  static React build (S3)    /api/* ──┐    │◄─── Employers (/verify)
                     └──────────────────────────────────────┼────┘
                                                            ▼
                                                ┌───────────────────────┐
                                                │ Application LB (WAF)  │
                                                └──────────┬────────────┘
                                                           ▼
                                   ┌─────────────────────────────────────┐
                                   │ API service (ECS Fargate, 2-6 tasks)│
                                   │ stateless · SSE · JWT · rate limits │
                                   └──┬───────────────┬──────────────┬───┘
                    tx: change+audit  │      cache /  │ pub/sub      │ presigned GET
                    +outbox row       ▼      queues   ▼              ▼
                     ┌────────────────────┐   ┌──────────────────┐  ┌─────────────────┐
                     │ RDS PostgreSQL     │   │ ElastiCache Redis│  │ S3 (private,    │
                     │ Multi-AZ + replica │   │ primary+replica  │  │ SSE-KMS) PDFs   │
                     └─────────▲──────────┘   └───────▲──────────┘  └────────▲────────┘
                               │ outbox relay         │ BullMQ               │ put
                               │ (SKIP LOCKED)        │ jobs                 │
                     ┌─────────┴──────────────────────┴──────────────────────┴───┐
                     │ Worker services (ECS Fargate, autoscaled on queue depth)  │
                     │  • relay+sweeps (2 tasks)   • pdf-worker (2→12 tasks)      │
                     │  • delivery-worker (2→6 tasks, global rate limiter)        │
                     └──────────────────────────────┬────────────────────────────┘
                                                    ▼ HTTPS, idempotent
                                       WhatsApp Business API (BSP / Cloud API)
                                                    │ delivery status webhooks
                                                    └──► API /webhooks/whatsapp
```

**How events flow:**
`decision committed (Postgres: batch status + audit + outbox row)`
→ the relay claims outbox rows (`FOR UPDATE SKIP LOCKED`)
→ BullMQ `certificate-pdf` (jobId `pdf-<certId>`)
→ PDF to S3
→ BullMQ `certificate-delivery` (jobId `deliver-<certId>`)
→ WhatsApp send (idempotency key = cert id)
→ delivery status in Postgres + audit
→ Redis pub/sub
→ SSE to the browsers that are allowed to see it.

In production I would split the single local worker image into three ECS services (relay/sweeps, pdf, delivery), so each scales on its own signal. The code already uses separate queues for exactly this.

## 2. Where each component is hosted, and why

**Region: AWS ap-south-1 (Mumbai)**, so candidate personal data stays in India (DPDP Act) and latency to Indian users is low.

| Component | Hosting | Why |
|---|---|---|
| Frontend | S3 + CloudFront | Static files, no servers, cached at the edge. `/verify` loads fast during bursts. |
| API | ECS Fargate behind ALB + AWS WAF | Stateless containers (the same image as local). No servers to patch. WAF adds IP rate limits and bot rules in front of `/api/public/*`. |
| Workers | ECS Fargate, 3 services | Scale on queue depth. A crash is harmless (jobs are retried, handlers are idempotent). |
| PostgreSQL | RDS PostgreSQL 16, Multi-AZ, `db.m6g.large`, 1 read replica | The source of truth: needs automated failover, point-in-time recovery and backups. The replica serves reporting and dashboard reads. |
| Redis | ElastiCache Redis 7, primary + replica, Multi-AZ | Queues, cache, rate limits, pub/sub. Losing it costs latency, not data (see failure handling). |
| Certificate PDFs | S3 private bucket, SSE-KMS, versioning, Object Lock (governance) | Durable, cheap, and access is controlled per object with presigned URLs. |
| Secrets | AWS Secrets Manager | JWT/download HMAC keys and DB credentials, rotated, never baked into images. |
| WhatsApp | A BSP (e.g. Gupshup / Meta Cloud API) | Approved **utility template** with a document header. |

## 3. Scaling

**Scales horizontally (add tasks):**
- **API:** stateless, with sessions in JWTs. Realtime fan-out goes through Redis pub/sub, so any task can serve any user. Autoscales on CPU and request count.
- **PDF workers:** CPU-bound. Rendering takes ~60 ms of CPU per certificate, so 1 vCPU ≈ 15/s. At peak, **4 tasks clear 30,000 PDFs in ~10 minutes**. We autoscale on `certificate-pdf` waiting jobs (target ≤ 2,000 waiting per task).
- **Delivery workers:** I/O-bound. 2-6 tasks with concurrency 10 each.
- **Outbox relay:** several relays can run at once (SKIP LOCKED). One is enough: 500 events/hour is tiny.

**What limits throughput at peak (in order):**
1. **WhatsApp itself.** Two limits matter:
   - **Throughput** (Cloud API default ~80 msg/s per number). Our BullMQ limiter is *global across all workers*, set just under the provider's cap. 30,000 / 60 per s ≈ **8-9 minutes**.
   - **Messaging tier** (unique recipients per 24 h). 30,000 candidates on one day needs at least the **100K tier**. *Operational action: get the business number upgraded well before results season.* If we're capped, the backlog simply waits in the queue and drains as quota frees up. Certificates are already downloadable via `/verify` + the centre in the meantime.
2. **Postgres write rate.** ~60k small conditional updates/hour (PDF done, delivered) is ~17 writes/s, far below what `db.m6g.large` can do. Connection count is controlled with a pool per task (Prisma `connection_limit`) and RDS Proxy if the task count grows.
3. **PDF CPU:** linear in worker tasks, see above.

**How the backlog is cleared:** queues absorb the spike. Autoscaling adds PDF workers as the waiting count grows; the delivery rate is pinned to the provider cap. Jobs retry with exponential backoff. Anything that falls out of Redis is re-enqueued from Postgres by the reconciler (every minute: certificates still `PENDING` after 2 minutes). Dashboard SLO: *95% of certificates delivered within 30 minutes of approval on results day.*

**Public verification bursts:** CloudFront serves the page; the API answers from the Redis cache (30 s TTL, evicted on revoke). A cache miss is one indexed lookup by primary key. WAF + Redis rate limits stop scraping, and the number+code requirement makes enumeration pointless.

## 4. Failure handling

| Failure | What happens | Why nothing is lost or duplicated |
|---|---|---|
| **Worker crash mid-job** | BullMQ notices the stalled job (lock expiry ~30 s) and hands it to another worker. | Handlers are idempotent: the PDF is overwritten at the same key; the send uses the idempotency key; status changes are conditional (`WHERE deliveryStatus <> 'SENT'`). A crash between "relay enqueued" and "outbox marked" just re-relays, and jobIds dedupe it. |
| **API instance restart** | ALB drains it; SSE clients reconnect automatically (frontend backoff). | Every decision is a single DB transaction: it either committed (with audit + outbox) or it didn't. Row locks are released on disconnect. |
| **Redis restart / failover** | Queues pause; verify falls back to Postgres; rate limiting fails open (WAF still protects); SSE reconnects. | ElastiCache replica promotion keeps most queue state. Anything lost is rebuilt from Postgres: the outbox relay retries unpublished events, and the **reconciler** re-enqueues every certificate not yet `SENT`. The verify cache only holds data that can be rebuilt. Revocations are in Postgres and the cache TTL is 30 s. |
| **WhatsApp outage** | Sends fail → exponential backoff (25 attempts, capped) → eventually `FAILED`, visible to the state office with a one-click retry. A CloudWatch alarm fires on failure rate. | Nothing blocks the UI: approvals keep working. When the provider comes back, retries and the reconciler drain the backlog at the rate limit. The idempotency key prevents duplicates from "timed out but actually sent". The provider's status webhook (next step) confirms delivery. |
| **Slow database** | API p95 rises; workers slow down (they wait, they don't fail). The outbox backlog grows. | Statement timeouts (5 s API, 30 s jobs) stop pile-ups; the connection pool caps the load. Correctness doesn't depend on timing: locks and constraints still hold. Alarms on RDS CPU/IO/locks; read replica for dashboards; scale up the instance class (Multi-AZ failover ~60 s). |
| **Region-level disaster** | Restore RDS from cross-region snapshot; S3 cross-region replication. | RPO ≤ 5 min (PITR), RTO ~2 h (documented runbook). Acceptable for a certification system. |

## 5. Certificate file storage and access control
- PDFs live in a **private S3 bucket** (`s3://certiflow-certs-prod/<yyyy>/<certId>.pdf`): Block Public Access on, SSE-KMS encryption, versioning, and Object Lock in governance mode, so an issued file can't be silently replaced.
- **Nobody gets a bucket URL.** Access always goes through the API, which checks the requester and then returns a **presigned S3 URL valid for 5 minutes**:
  - **Candidates:** the WhatsApp link carries an HMAC token bound to that certificate id and an expiry (30 days). Revoked certificates are refused.
  - **Centres:** only their own batches. **State office:** everything. **Officers:** none (they review data, not issued files).
- **Revocation** doesn't delete the file (evidence). Downloads are refused and `/verify` says *no longer valid*.
- **Workers** have an IAM role scoped to `PutObject` on the prefix; **API** tasks only `GetObject` (to presign). No other principal can read the bucket.
- **Lifecycle:** move to S3 Standard-IA after 90 days. Certificates are kept for 10 years (programme retention policy).

## 6. Monitoring and alerting
- **Logs:** structured JSON (pino) → CloudWatch Logs, with `requestId` on every line, audit row and job. "What happened to certificate X" is one query, and `GET /api/certificates/:id/timeline` shows it in the product.
- **Metrics** (OpenTelemetry → CloudWatch/Grafana): request rate/latency/errors per route; queue depth and job age per queue; delivery success/failure rate; WhatsApp latency and status codes; outbox lag (oldest unpublished row); number of escalated batches; DB connections and lock waits.
- **Alerts** (PagerDuty/Slack):
  - outbox lag > 2 min
  - oldest `certificate-delivery` job > 15 min
  - delivery failure rate > 10% over 10 min
  - any certificate in `FAILED`
  - API 5xx > 1%
  - `/verify` p95 > 500 ms
  - RDS CPU > 80% / free storage < 20%
  - Redis memory > 75%
  - a spike in 401/403 (credential stuffing or tampering)
- **Synthetic check:** every 5 min, verify a known canary certificate (valid) and a revoked one (must say revoked).

## 7. Rough monthly cost (ap-south-1, on-demand, USD)

| Item | Sizing | ~$/month |
|---|---|---|
| RDS PostgreSQL | db.m6g.large Multi-AZ + 200 GB gp3 + 1 read replica (t4g.medium) | 380 |
| ElastiCache Redis | cache.t4g.medium primary + replica | 100 |
| ECS Fargate: API | 2 × (0.5 vCPU, 1 GB) always-on, bursts to 6 | 40 |
| ECS Fargate: workers | 4 × (1 vCPU, 2 GB) baseline, bursts on results day | 120 |
| ALB + WAF | 1 ALB, WAF with managed rules | 45 |
| NAT gateway + data transfer | 1 NAT (outbound to WhatsApp BSP) | 50 |
| S3 + CloudFront | ~100k PDFs/year × 150 KB ≈ 15 GB, CDN traffic | 15 |
| CloudWatch logs/metrics/alarms, Secrets Manager, KMS | | 60 |
| **Infrastructure total** | | **≈ $810** |
| WhatsApp messages | ~8,000-30,000 utility template msgs × ~$0.0014 (India utility rate) + BSP fee | 20-60 |

**Trade-offs behind the number:**
- *Multi-AZ RDS is the biggest line item, and I'd keep it.* Postgres is the only thing that can't be rebuilt. Downgrading to single-AZ saves ~$150 but turns a hardware failure into hours of downtime on results day.
- *Fargate over EC2/Kubernetes:* slightly higher unit price, but no cluster to operate for a small team. Fargate Spot for the PDF workers (they are interruptible and idempotent) cuts that line by ~60%.
- *Redis is not Multi-AZ-critical,* since everything in it can be rebuilt. A single node would save ~$50 at the cost of a few minutes' delay after a failure.
- *Savings Plans / Reserved Instances* for RDS and baseline Fargate cut ~30% (≈ $550/month) once usage is stable.
- *Not chosen:* Kafka/MSK (~$300+/month minimum) is unnecessary at 60k events/hour peak; BullMQ on the Redis we already need covers it.
