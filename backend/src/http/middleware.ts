import crypto from 'node:crypto';
import { NextFunction, Request, RequestHandler, Response } from 'express';
import { Role } from '@prisma/client';
import { ZodError, ZodSchema } from 'zod';
import { Actor } from '../domain/workflow';
import { logger, prisma } from '../infra';
import { forbidden, HttpError, unauthorized } from '../lib/errors';
import { verifySession } from '../lib/tokens';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      actor?: Actor;
    }
  }
}

/** Correlation id: accepted from the caller if well-formed, else generated. */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.header('x-request-id');
  req.requestId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader('x-request-id', req.requestId);
  next();
};

/**
 * Identity comes ONLY from the signed token. Any userId/actorId in a body or
 * query is ignored, so nobody can act as someone else by editing a request.
 * The user is re-read from the DB on every request so role changes apply at once.
 */
export const authenticate: RequestHandler = async (req, _res, next) => {
  try {
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const claims = token ? verifySession(token) : null;
    if (!claims) throw unauthorized();
    const user = await prisma.user.findUnique({ where: { id: claims.sub } });
    if (!user) throw unauthorized('Unknown user');
    req.actor = { id: user.id, name: user.name, role: user.role, districtId: user.districtId, centreId: user.centreId };
    next();
  } catch (err) {
    next(err);
  }
};

export const requireRole =
  (...roles: Role[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.actor || !roles.includes(req.actor.role)) return next(forbidden());
    next();
  };

export function parse<T>(schema: ZodSchema<T>, data: unknown): T {
  return schema.parse(data);
}

/** Wrap async handlers so thrown errors reach the error middleware. */
export const ah =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: { code: 'BAD_REQUEST', message: 'Invalid request', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
      requestId: req.requestId,
    });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details }, requestId: req.requestId });
  }
  if (err && typeof err === 'object' && 'type' in err && (err as { type: string }).type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Malformed JSON' }, requestId: req.requestId });
  }
  logger.error({ err, requestId: req.requestId }, 'unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' }, requestId: req.requestId });
}
