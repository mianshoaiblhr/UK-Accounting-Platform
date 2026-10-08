import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import helmet from 'helmet';
import { loadConfig, type AppConfig } from '@uk/core';
import { AppModule } from './app.module';
import { LOGGER } from './common/tokens';
import { requestContextMiddleware } from './common/request-context.middleware';

export async function createApp(config: AppConfig = loadConfig()): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), { bodyParser: false, logger: ['error', 'warn'] });
  app.set('trust proxy', config.TRUST_PROXY_HOPS);
  app.disable('x-powered-by');
  app.use(requestContextMiddleware);
  app.use(helmet({
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    hsts: config.isProduction ? { maxAge: 31536000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'no-referrer' },
  }));
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
  app.enableShutdownHooks();
  return app;
}
