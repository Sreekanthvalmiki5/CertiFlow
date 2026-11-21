// Login tokens (JWT) and signed candidate download links (HMAC).
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config';

export interface SessionClaims {
  sub: string; // user id
}

export function signSession(userId: string): string {
  return jwt.sign({ sub: userId } satisfies SessionClaims, config.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: '8h',
    issuer: 'certiflow',
  });
}

export function verifySession(token: string): SessionClaims | null {
  try {
    // Pin the algorithm so an "alg: none" or RS/HS confusion token is rejected.
    const claims = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'], issuer: 'certiflow' });
    if (typeof claims === 'string' || typeof claims.sub !== 'string') return null;
    return { sub: claims.sub };
  } catch {
    return null;
  }
}

function hmac(data: string): string {
  return crypto.createHmac('sha256', config.downloadSecret).update(data).digest('base64url');
}

/** Download token bound to one certificate id with an expiry. */
export function signDownloadToken(certificateId: string, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + config.downloadLinkTtlDays * 86400;
  return `${exp}.${hmac(`${certificateId}.${exp}`)}`;
}

export function verifyDownloadToken(certificateId: string, token: string, now = Date.now()): boolean {
  const [expRaw, sig] = token.split('.');
  const exp = Number(expRaw);
  if (!sig || !Number.isInteger(exp) || exp * 1000 < now) return false;
  const expected = hmac(`${certificateId}.${exp}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Short human-typeable verification code, no ambiguous characters. */
export function newVerifyCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/** "Ravi Kumar" -> "R*** K****": enough for an employer to match, useless to a scraper. */
export function maskName(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0] + '*'.repeat(Math.max(part.length - 1, 2)))
    .join(' ');
}
