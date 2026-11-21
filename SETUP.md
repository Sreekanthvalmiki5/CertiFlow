# Local setup

## Option A: everything in Docker (recommended)

Prerequisite: Docker Desktop (or Docker Engine + Compose v2). Ports 8080, 5433 and 6380 must be free.

```bash
git clone https://github.com/Sreekanthvalmiki5/CertiFlow.git
cd CertiFlow
docker compose up --build
```

When the logs settle (around a minute on the first build), open **http://localhost:8080** and pick a demo person:
Anika (training centre), Dev / Meera / Kabir (district officers, Pune), Neha (quality team), Farah (state office). There are two extra users who prove isolation: Ravi (Nashik officer) and Ishaan (Nashik centre).

The `migrate` container applies migrations and seeds demo data on every start. The seed is idempotent. Sample data includes:
- a draft batch
- a batch with one district approval
- a 60-candidate batch waiting for the state office
- an approved batch whose certificates are delivered by the worker
- a batch submitted three days ago, which the SLA sweeper escalates

Public pages: http://localhost:8080/verify and http://localhost:8080/phone (demo candidate inbox).

### Run the tests
```bash
docker compose --profile test run --rm tests
```
This uses a separate database (`certiflow_test`) and Redis DB 1, so it never touches the demo data.

### Useful knobs (env vars, e.g. `WA_FAILURE_RATE=0.5 docker compose up`)
| Variable | Default | Meaning |
|---|---|---|
| `WA_FAILURE_RATE` / `WA_TIMEOUT_RATE` | 0.2 / 0.1 | How unreliable the WhatsApp stand-in is |
| `STAGE_SLA_MINUTES` | 30 | How long a batch may sit in one stage before escalation |
| `DISTRICT_QUORUM` | 2 | Officers needed to agree at district level |
| `LARGE_BATCH_THRESHOLD` | 50 | Size from which the quality team reviews |

To simulate a WhatsApp outage at runtime:
`docker compose exec api wget -qO- --post-data='{"failureRate":1}' --header=content-type:application/json http://whatsapp:4100/v1/config`
(set it back to `0.2` afterwards, and the retries drain the backlog).

### Reset everything
```bash
docker compose down -v
```

## Option B: run the Node processes on your machine (for development)

Prerequisites: Node 22+, Docker (for Postgres and Redis only).

```bash
docker compose up -d postgres redis            # Postgres on :5433, Redis on :6380

cd backend
npm ci
cp .env.example .env                            # points at localhost:5433 / :6380
npx prisma migrate deploy
npm run seed
npm run dev            # API on :4000           (terminal 1)
npm run dev:worker     # worker                 (terminal 2)
npm run dev:whatsapp   # WhatsApp stand-in :4100 (terminal 3)

cd ../frontend
npm ci
npm run dev            # http://localhost:5173 (proxies /api to :4000)
```

Tests from the host (needs the compose Postgres and Redis running):
```bash
cd backend
DATABASE_URL=postgresql://certiflow:certiflow@localhost:5433/certiflow_test npx prisma migrate deploy
npm test
```
