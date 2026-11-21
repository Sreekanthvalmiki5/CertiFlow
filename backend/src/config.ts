// Central configuration. Every knob is an env var with a safe local default so
// a fresh clone runs without editing anything.

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Env ${name} must be a number, got "${raw}"`);
  return n;
}

function str(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

const nodeEnv = str('NODE_ENV', 'development');
const jwtSecret = str('JWT_SECRET', 'dev-only-change-me-dev-only-change-me');
if (nodeEnv === 'production' && jwtSecret.startsWith('dev-only')) {
  throw new Error('JWT_SECRET must be set in production');
}

export const config = {
  nodeEnv,
  port: int('PORT', 4000),
  databaseUrl: str('DATABASE_URL', 'postgresql://certiflow:certiflow@localhost:5432/certiflow'),
  redisUrl: str('REDIS_URL', 'redis://localhost:6379'),
  jwtSecret,
  // Signs candidate download links (separate from login tokens).
  downloadSecret: str('DOWNLOAD_SECRET', 'dev-only-download-secret-change-me'),
  downloadLinkTtlDays: int('DOWNLOAD_LINK_TTL_DAYS', 30),
  publicBaseUrl: str('PUBLIC_BASE_URL', 'http://localhost:8080'),

  // Workflow rules (see README "Decisions").
  districtQuorum: int('DISTRICT_QUORUM', 2),
  largeBatchThreshold: int('LARGE_BATCH_THRESHOLD', 50),
  maxBatchSize: int('MAX_BATCH_SIZE', 1000),
  stageSlaMinutes: int('STAGE_SLA_MINUTES', 120),
  slaSweepIntervalMs: int('SLA_SWEEP_INTERVAL_MS', 30_000),

  // Certificates + delivery.
  certificateDir: str('CERTIFICATE_DIR', './data/certificates'),
  certificatePrefix: str('CERTIFICATE_PREFIX', 'PSM'),
  whatsappUrl: str('WHATSAPP_URL', 'http://localhost:4100'),
  whatsappTimeoutMs: int('WHATSAPP_TIMEOUT_MS', 3000),
  whatsappAttempts: int('WHATSAPP_ATTEMPTS', 10),
  whatsappBackoffMs: int('WHATSAPP_BACKOFF_MS', 1000),
  whatsappRatePerSec: int('WHATSAPP_RATE_PER_SEC', 20),
  reconcileIntervalMs: int('RECONCILE_INTERVAL_MS', 60_000),
  reconcileStaleAfterMs: int('RECONCILE_STALE_AFTER_MS', 120_000),

  // Public verification.
  verifyCacheTtlSec: int('VERIFY_CACHE_TTL_SEC', 30),
  verifyRateLimitPerMin: int('VERIFY_RATE_LIMIT_PER_MIN', 60),

  outboxPollMs: int('OUTBOX_POLL_MS', 300),
  logLevel: str('LOG_LEVEL', nodeEnv === 'test' ? 'silent' : 'info'),
};
