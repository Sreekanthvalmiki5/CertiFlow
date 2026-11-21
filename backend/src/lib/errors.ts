// Typed HTTP errors. Route handlers throw these; one middleware turns them
// into consistent JSON responses.
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, 'BAD_REQUEST', msg, details);
export const unauthorized = (msg = 'Authentication required') => new HttpError(401, 'UNAUTHORIZED', msg);
export const forbidden = (msg = 'You are not allowed to do this') => new HttpError(403, 'FORBIDDEN', msg);
export const notFound = (msg = 'Not found') => new HttpError(404, 'NOT_FOUND', msg);
export const conflict = (msg: string, details?: unknown) => new HttpError(409, 'CONFLICT', msg, details);
export const unprocessable = (msg: string, details?: unknown) => new HttpError(422, 'VALIDATION_FAILED', msg, details);
export const tooMany = (msg = 'Too many requests') => new HttpError(429, 'RATE_LIMITED', msg);

/** True when Prisma reports a unique-constraint violation. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}
