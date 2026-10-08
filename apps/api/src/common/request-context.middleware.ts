import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { runWithContext } from '@uk/core';

const SAFE_ID = /^[\w.\-:]{8,100}$/;

export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  const correlationId = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-request-id', correlationId);
  runWithContext({ correlationId, ip: req.ip, userAgent: req.header('user-agent')?.slice(0, 300) }, next);
}
