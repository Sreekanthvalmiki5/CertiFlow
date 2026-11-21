import fs from 'node:fs';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config';
import {
  batchVisibilityWhere,
  canSeeBatch,
  createBatch,
  decide,
  replaceCandidates,
  revokeCertificate,
  submitBatch,
} from '../domain/batchService';
import { readRows, validateRows } from '../domain/spreadsheet';
import { allowVerification, invalidateVerification, verifyCertificate } from '../domain/verification';
import { PENDING_STATUSES, STAGE_OF_STATUS, whyCannotDecide } from '../domain/workflow';
import { prisma, redis } from '../infra';
import { enqueuePdf } from '../jobs/queues';
import { badRequest, conflict, forbidden, notFound, tooMany, unprocessable } from '../lib/errors';
import { signSession, verifyDownloadToken } from '../lib/tokens';
import { attachClient } from '../realtime/hub';
import { ah, authenticate, parse, requireRole } from './middleware';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
const uuid = z.string().uuid();
const idParam = (raw: string) => {
  const r = uuid.safeParse(raw);
  if (!r.success) throw notFound();
  return r.data;
};

export function publicRoutes() {
  const r = Router();

  r.get('/health', ah(async (_req, res) => {
    const [db, cache] = await Promise.allSettled([prisma.$queryRaw`SELECT 1`, redis.ping()]);
    const ok = db.status === 'fulfilled';
    res.status(ok ? 200 : 503).json({ ok, db: db.status, redis: cache.status });
  }));

  // ---- demo sign-in (stands in for real SSO/OTP; see README) ----
  r.get('/auth/demo-users', ah(async (_req, res) => {
    const users = await prisma.user.findMany({ include: { district: true, centre: true }, orderBy: { id: 'asc' } });
    res.json(users.map((u) => ({ id: u.id, name: u.name, role: u.role, district: u.district?.name ?? null, centre: u.centre?.name ?? null })));
  }));
  r.post('/auth/demo-login', ah(async (req, res) => {
    const { userId } = parse(z.object({ userId: z.string().min(1).max(64) }), req.body);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw notFound('Unknown user');
    res.json({ token: signSession(user.id), user });
  }));

  // ---- public verification: no login, rate limited, minimal data ----
  r.get('/public/verify', ah(async (req, res) => {
    const q = parse(z.object({ n: z.string().min(3).max(40), c: z.string().min(4).max(20) }), req.query);
    if (!(await allowVerification(req.ip ?? 'unknown'))) throw tooMany('Too many checks, please wait a minute');
    res.setHeader('cache-control', 'no-store');
    res.json(await verifyCertificate(q.n, q.c));
  }));

  // ---- candidate download via signed link sent on WhatsApp ----
  r.get('/public/certificates/:id/download', ah(async (req, res) => {
    const id = idParam(req.params.id);
    const token = typeof req.query.t === 'string' ? req.query.t : '';
    if (!verifyDownloadToken(id, token)) throw forbidden('This download link is invalid or has expired');
    const cert = await prisma.certificate.findUnique({ where: { id } });
    if (!cert || !cert.pdfPath) throw notFound('Certificate not available yet');
    if (cert.status === 'REVOKED') throw forbidden('This certificate has been cancelled');
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-disposition', `attachment; filename="${cert.number}.pdf"`);
    fs.createReadStream(cert.pdfPath).pipe(res);
  }));

  // ---- demo only: the candidate's "phone", i.e. the stand-in provider inbox ----
  r.get('/demo/phone/:phone', ah(async (req, res) => {
    if (process.env.DEMO_MODE !== 'true') throw notFound();
    const phone = req.params.phone;
    if (!/^\+91[6-9]\d{9}$/.test(phone)) throw badRequest('Use +91XXXXXXXXXX');
    const r2 = await fetch(`${config.whatsappUrl}/v1/messages?to=${encodeURIComponent(phone)}`);
    res.json(await r2.json());
  }));

  return r;
}

export function privateRoutes() {
  const r = Router();
  r.use(authenticate);

  r.get('/me', (req, res) => res.json(req.actor));

  // Live updates. fetch()-based on the client so the token travels in a header,
  // not in a URL where it would end up in logs.
  r.get('/events', (req, res) => attachClient(req.actor!, res));

  // ---------------------------------------------------------------- batches
  r.get('/batches', ah(async (req, res) => {
    const actor = req.actor!;
    const queueOnly = req.query.scope === 'queue';
    const batches = await prisma.batch.findMany({
      where: batchVisibilityWhere(actor),
      include: { centre: { include: { district: true } }, decisions: true },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });
    const rows = batches
      .map((b) => {
        const stage = STAGE_OF_STATUS[b.status];
        const current = b.decisions.filter((d) => d.revision === b.revision && d.stage === stage);
        const myVote = current.find((d) => d.actorId === actor.id)?.decision ?? null;
        const awaitingMe = !!stage && !whyCannotDecide(actor, b.status, b.centre.districtId) && !myVote;
        return {
          id: b.id,
          title: b.title,
          course: b.course,
          status: b.status,
          revision: b.revision,
          candidateCount: b.candidateCount,
          centre: b.centre.name,
          district: b.centre.district.name,
          stageEnteredAt: b.stageEnteredAt,
          escalatedAt: b.escalatedAt,
          approvals: current.filter((d) => d.decision === 'APPROVE').length,
          myVote,
          awaitingMe,
          updatedAt: b.updatedAt,
        };
      })
      .filter((b) => !queueOnly || b.awaitingMe || (actor.role === 'CENTRE' && b.status === 'RETURNED'));
    res.json(rows);
  }));

  r.post('/batches', requireRole('CENTRE'), ah(async (req, res) => {
    const body = parse(
      z.object({ title: z.string().trim().min(3).max(120), course: z.string().trim().min(3).max(120) }),
      req.body,
    );
    res.status(201).json(await createBatch(req.actor!, body, req.requestId));
  }));

  async function loadVisibleBatch(actor: NonNullable<Express.Request['actor']>, id: string) {
    const batch = await prisma.batch.findUnique({ where: { id }, include: { centre: { include: { district: true } } } });
    // Same 404 for "missing" and "not yours": do not reveal which ids exist.
    if (!batch || !canSeeBatch(actor, { centreId: batch.centreId, districtId: batch.centre.districtId })) throw notFound('Batch not found');
    return batch;
  }

  r.get('/batches/:id', ah(async (req, res) => {
    const actor = req.actor!;
    const batch = await loadVisibleBatch(actor, idParam(req.params.id));
    const [candidates, decisions, certificates, users] = await Promise.all([
      prisma.candidate.findMany({ where: { batchId: batch.id }, orderBy: { rowNumber: 'asc' } }),
      prisma.decision.findMany({ where: { batchId: batch.id }, orderBy: { createdAt: 'asc' } }),
      prisma.certificate.findMany({ where: { batchId: batch.id }, orderBy: { number: 'asc' } }),
      prisma.user.findMany({ select: { id: true, name: true } }),
    ]);
    const nameOf = new Map(users.map((u) => [u.id, u.name]));
    const stage = STAGE_OF_STATUS[batch.status];
    const myVote = decisions.find((d) => d.revision === batch.revision && d.stage === stage && d.actorId === actor.id);
    const canDecide = !!stage && !whyCannotDecide(actor, batch.status, batch.centre.districtId) && !myVote;
    const showCertDetails = actor.role === 'STATE' || actor.role === 'CENTRE';
    res.json({
      id: batch.id,
      title: batch.title,
      course: batch.course,
      status: batch.status,
      revision: batch.revision,
      centre: batch.centre.name,
      district: batch.centre.district.name,
      candidateCount: batch.candidateCount,
      stageEnteredAt: batch.stageEnteredAt,
      escalatedAt: batch.escalatedAt,
      returnReason: batch.returnReason,
      returnedBy: batch.returnedBy,
      isLarge: batch.candidateCount >= config.largeBatchThreshold,
      districtQuorum: config.districtQuorum,
      canDecide,
      canEdit: actor.role === 'CENTRE' && (batch.status === 'DRAFT' || batch.status === 'RETURNED'),
      candidates: candidates.map((c) => ({ ...c, dateOfBirth: c.dateOfBirth.toISOString().slice(0, 10) })),
      decisions: decisions.map((d) => ({ ...d, actorName: nameOf.get(d.actorId) ?? d.actorId, current: d.revision === batch.revision })),
      certificateSummary: {
        total: certificates.length,
        sent: certificates.filter((c) => c.deliveryStatus === 'SENT').length,
        failed: certificates.filter((c) => c.deliveryStatus === 'FAILED').length,
        pending: certificates.filter((c) => c.deliveryStatus === 'PENDING').length,
        revoked: certificates.filter((c) => c.status === 'REVOKED').length,
      },
      certificates: showCertDetails
        ? certificates.map((c) => ({
            id: c.id,
            number: c.number,
            holderName: c.holderName,
            phone: c.phone,
            status: c.status,
            deliveryStatus: c.deliveryStatus,
            deliveryAttempts: c.deliveryAttempts,
            lastDeliveryError: c.lastDeliveryError,
            hasPdf: !!c.pdfPath,
          }))
        : [],
    });
  }));

  r.post('/batches/:id/candidates', requireRole('CENTRE'), upload.single('file'), ah(async (req, res) => {
    const batchId = idParam(req.params.id);
    await loadVisibleBatch(req.actor!, batchId);
    if (!req.file) throw badRequest('Attach the spreadsheet as "file"');
    let parsed;
    try {
      parsed = await readRows(req.file.buffer, req.file.originalname);
    } catch (err) {
      if ((err as Error).message === 'UNSUPPORTED_FILE') throw badRequest('Upload a .csv or .xlsx file');
      throw badRequest('The file could not be read as a spreadsheet');
    }
    const { candidates, errors } = validateRows(parsed.headers, parsed.rows);
    if (errors.length) {
      throw unprocessable(`${new Set(errors.map((e) => e.row)).size} row(s) have problems. Nothing was saved.`, errors);
    }
    res.json(await replaceCandidates(req.actor!, batchId, candidates, req.requestId));
  }));

  r.post('/batches/:id/submit', requireRole('CENTRE'), ah(async (req, res) => {
    const batchId = idParam(req.params.id);
    await loadVisibleBatch(req.actor!, batchId);
    res.json(await submitBatch(req.actor!, batchId, req.requestId));
  }));

  r.post('/batches/:id/decisions', requireRole('OFFICER', 'QUALITY', 'STATE'), ah(async (req, res) => {
    const batchId = idParam(req.params.id);
    await loadVisibleBatch(req.actor!, batchId);
    const body = parse(
      z
        .object({
          decision: z.enum(['APPROVE', 'REJECT', 'SEND_BACK']),
          reason: z.string().trim().max(1000).optional(),
          revision: z.number().int().positive(),
        })
        .strict() // unknown fields (e.g. a forged "actorId") are rejected outright
        .refine((b) => b.decision === 'APPROVE' || (b.reason && b.reason.length >= 5), {
          message: 'A reason of at least 5 characters is required to reject or send back',
          path: ['reason'],
        }),
      req.body,
    );
    res.json(await decide(req.actor!, batchId, body, req.requestId));
  }));

  r.get('/batches/:id/timeline', ah(async (req, res) => {
    const batch = await loadVisibleBatch(req.actor!, idParam(req.params.id));
    const events = await prisma.auditEvent.findMany({ where: { batchId: batch.id }, orderBy: { id: 'asc' }, take: 2000 });
    const users = await prisma.user.findMany({ select: { id: true, name: true } });
    const nameOf = new Map(users.map((u) => [u.id, u.name]));
    res.json(events.map((e) => ({ ...e, id: e.id.toString(), actorName: e.actorId ? nameOf.get(e.actorId) ?? e.actorId : 'system' })));
  }));

  // ------------------------------------------------------------ state office
  r.get('/escalations', requireRole('STATE'), ah(async (_req, res) => {
    const batches = await prisma.batch.findMany({
      where: { status: { in: PENDING_STATUSES }, escalatedAt: { not: null } },
      include: { centre: { include: { district: true } } },
      orderBy: { stageEnteredAt: 'asc' },
    });
    res.json(
      batches.map((b) => ({
        id: b.id,
        title: b.title,
        status: b.status,
        centre: b.centre.name,
        district: b.centre.district.name,
        stageEnteredAt: b.stageEnteredAt,
        escalatedAt: b.escalatedAt,
        waitingMinutes: Math.round((Date.now() - b.stageEnteredAt.getTime()) / 60_000),
      })),
    );
  }));

  r.get('/certificates', requireRole('STATE'), ah(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toUpperCase().slice(0, 40) : '';
    const certs = await prisma.certificate.findMany({
      where: q ? { OR: [{ number: { contains: q } }, { enrollmentNo: { contains: q } }] } : {},
      orderBy: { issuedAt: 'desc' },
      take: 50,
    });
    res.json(certs.map(({ verifyCode: _omit, ...c }) => c));
  }));

  r.post('/certificates/:id/revoke', requireRole('STATE'), ah(async (req, res) => {
    const id = idParam(req.params.id);
    const { reason } = parse(z.object({ reason: z.string().trim().min(5).max(1000) }).strict(), req.body);
    const result = await revokeCertificate(req.actor!, id, reason, req.requestId);
    // Synchronous cache eviction right after commit: the very next public
    // check reads the new status. The outbox relay evicts again as a backstop.
    await invalidateVerification(result.number);
    res.json({ ok: true, number: result.number, status: 'REVOKED' });
  }));

  r.post('/certificates/:id/retry-delivery', requireRole('STATE'), ah(async (req, res) => {
    const id = idParam(req.params.id);
    const updated = await prisma.certificate.updateMany({ where: { id, deliveryStatus: 'FAILED', status: 'VALID' }, data: { deliveryStatus: 'PENDING' } });
    if (!updated.count) throw conflict('Only failed deliveries of valid certificates can be retried');
    await prisma.auditEvent.create({ data: { entityType: 'certificate', entityId: id, action: 'certificate.delivery_retried', actorId: req.actor!.id, actorRole: req.actor!.role, requestId: req.requestId } });
    await enqueuePdf([id], req.requestId);
    res.json({ ok: true });
  }));

  r.get('/certificates/:id/timeline', requireRole('STATE'), ah(async (req, res) => {
    const id = idParam(req.params.id);
    const events = await prisma.auditEvent.findMany({ where: { entityType: 'certificate', entityId: id }, orderBy: { id: 'asc' } });
    res.json(events.map((e) => ({ ...e, id: e.id.toString() })));
  }));

  return r;
}
