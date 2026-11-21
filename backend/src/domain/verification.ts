// Public certificate verification. Read-heavy and bursty, so results are
// cached in Redis for a short TTL; revocation deletes the cache entry so a
// cancelled certificate is never served as valid from cache. If Redis is
// down we fall back to Postgres (slower, still correct).
import crypto from 'node:crypto';
import { config } from '../config';
import { logger, prisma, redis } from '../infra';
import { maskName } from '../lib/tokens';

export interface PublicVerification {
  result: 'VALID' | 'REVOKED' | 'NOT_FOUND';
  certificateNumber?: string;
  holderName?: string; // masked
  course?: string;
  centre?: string;
  issuedAt?: string;
  revokedAt?: string | null;
}

interface CachedRecord {
  codeHash: string;
  status: 'VALID' | 'REVOKED';
  holderName: string;
  course: string;
  centre: string;
  issuedAt: string;
  revokedAt: string | null;
}

const cacheKey = (number: string) => `verify:${number}`;
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export async function invalidateVerification(number: string) {
  try {
    await redis.del(cacheKey(number));
  } catch (err) {
    // Bounded staleness: the TTL (default 30s) still expires the entry.
    logger.warn({ err: (err as Error).message, number }, 'could not invalidate verify cache');
  }
}

async function loadRecord(number: string): Promise<CachedRecord | null> {
  try {
    const hit = await redis.get(cacheKey(number));
    if (hit) return JSON.parse(hit) as CachedRecord;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'verify cache read failed; using database');
  }
  const cert = await prisma.certificate.findUnique({ where: { number } });
  if (!cert) return null;
  const record: CachedRecord = {
    codeHash: sha(cert.verifyCode),
    status: cert.status,
    holderName: maskName(cert.holderName),
    course: cert.course,
    centre: cert.centreName,
    issuedAt: cert.issuedAt.toISOString(),
    revokedAt: cert.revokedAt?.toISOString() ?? null,
  };
  try {
    await redis.set(cacheKey(number), JSON.stringify(record), 'EX', config.verifyCacheTtlSec);
  } catch {
    /* cache is optional */
  }
  return record;
}

/**
 * Both the number AND the code printed on the certificate are required. A wrong
 * code looks exactly like a missing certificate, so numbers cannot be enumerated.
 */
export async function verifyCertificate(numberRaw: string, codeRaw: string): Promise<PublicVerification> {
  const number = numberRaw.trim().toUpperCase();
  const code = codeRaw.trim().toUpperCase();
  const record = await loadRecord(number);
  if (!record) return { result: 'NOT_FOUND' };
  const given = Buffer.from(sha(code));
  const expected = Buffer.from(record.codeHash);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { result: 'NOT_FOUND' };
  return {
    result: record.status,
    certificateNumber: number,
    holderName: record.holderName,
    course: record.course,
    centre: record.centre,
    issuedAt: record.issuedAt,
    revokedAt: record.revokedAt,
  };
}

/** Fixed-window rate limit per client key. Fails open if Redis is down. */
export async function allowVerification(clientKey: string): Promise<boolean> {
  try {
    const key = `rl:verify:${clientKey}:${Math.floor(Date.now() / 60_000)}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 61);
    return count <= config.verifyRateLimitPerMin;
  } catch {
    return true;
  }
}
