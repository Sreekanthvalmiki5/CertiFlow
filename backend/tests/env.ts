// Runs before any test module is imported, so config.ts sees these values.
import os from 'node:os';
import path from 'node:path';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://certiflow:certiflow@localhost:5433/certiflow_test';
process.env.REDIS_URL ??= 'redis://localhost:6380/1';
process.env.WHATSAPP_URL = 'http://127.0.0.1:47100';
process.env.WHATSAPP_TIMEOUT_MS = '250';
process.env.WHATSAPP_BACKOFF_MS = '20';
process.env.WHATSAPP_ATTEMPTS = '25';
process.env.WHATSAPP_RATE_PER_SEC = '1000';
process.env.OUTBOX_POLL_MS = '50';
process.env.CERTIFICATE_DIR = path.join(os.tmpdir(), 'certiflow-test-certs');
process.env.DISTRICT_QUORUM = '2';
process.env.LARGE_BATCH_THRESHOLD = '50';
process.env.STAGE_SLA_MINUTES = '60';
