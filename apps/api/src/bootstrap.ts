import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import helmet from 'helmet';
import { EMF_DIMENSION_KEYS, loadConfig, startEmfEmitter, type AppConfig, type MetricsRegistry } from '@uk/core';
import { AppModule } from './app.module';
import { LOGGER, METRICS } from './common/tokens';
import { accessLog } from './common/access-log.middleware';
import { mountApiDocs } from './openapi/build';
import { requestContextMiddleware } from './common/request-context.middleware';

export async function createApp(config: AppConfig = loadConfig()): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), { bodyParser: false, logger: ['error', 'warn'] });
  app.set('trust proxy', config.TRUST_PROXY_HOPS);
  app.disable('x-powered-by');
  app.use(requestContextMiddleware);
  const metrics = app.get<MetricsRegistry>(METRICS);
  app.use(accessLog(app.get(LOGGER), metrics, config));
  if (config.METRICS_EMF) {
    const stop = startEmfEmitter(metrics, { namespace: config.METRICS_NAMESPACE, service: 'api', intervalMs: config.METRICS_EMF_INTERVAL_MS, dimensionKeys: EMF_DIMENSION_KEYS });
    app.enableShutdownHooks();
    app.getHttpServer().once('close', stop);
  }
  const hsts = config.isProduction ? { maxAge: 31536000, includeSubDomains: true } : false;
  const strict = helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } }, hsts, referrerPolicy: { policy: 'no-referrer' } });
  // Swagger UI needs inline scripts/styles: relax CSP for the docs path only (never the API itself).
  const docs = helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], frameAncestors: ["'none'"] } }, hsts, referrerPolicy: { policy: 'no-referrer' } });
  app.use((req: Request, res: Response, next: NextFunction) => (req.path.startsWith('/api/docs') ? docs : strict)(req, res, next));
  app.enableCors({
    origin: config.corsOrigins, credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['content-type', 'authorization', 'idempotency-key', 'x-request-id'],
    exposedHeaders: ['x-request-id', 'idempotent-replayed', 'retry-after'],
  });
  app.use(cookieParser());
  // Raw bytes for document content uploads (must precede the JSON parser).
  app.use(/^\/api\/v1\/organisations\/[^/]+\/documents\/[^/]+\/versions\/[^/]+\/content$/, (req: Request, res: Response, next: NextFunction) =>
    req.method === 'PUT' ? express.raw({ type: () => true, limit: config.MAX_UPLOAD_BYTES })(req, res, next) : next());
  app.use(express.json({ limit: '1mb' }));
  app.setGlobalPrefix('api/v1', { exclude: [] });
  app.useLogger({
    log: () => undefined, error: (m: unknown) => app.get(LOGGER).error(m), warn: (m: unknown) => app.get(LOGGER).warn(m),
  });
  if (config.apiDocsEnabled) mountApiDocs(app);
  app.enableShutdownHooks();
  return app;
}
