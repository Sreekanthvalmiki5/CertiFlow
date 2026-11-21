import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { errorHandler, requestId } from './http/middleware';
import { privateRoutes, publicRoutes } from './http/routes';
import { logger } from './infra';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // behind nginx: req.ip is the real client (rate limiting)
  app.use(helmet());
  app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') ?? false }));
  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).requestId,
      // Never log tokens or query strings that may contain them.
      serializers: { req: (req) => ({ id: req.id, method: req.method, url: String(req.url).split('?')[0] }) },
    }),
  );
  app.use(express.json({ limit: '100kb' }));
  app.use('/api', publicRoutes());
  app.use('/api', privateRoutes());
  app.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' }, requestId: req.requestId }));
  app.use(errorHandler);
  return app;
}
