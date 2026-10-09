import { randomBytes, randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { runWithContext } from '@uk/core';

const SAFE_ID = /^[\w.\-:]{8,100}$/;
/** W3C trace-context: version 00, 32-hex trace id (not all zeros), 16-hex parent id, flags. */
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  const correlationId = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-request-id', correlationId);
  // Trace context is propagated (accepted or created), never trusted for anything but correlation.
  const m = TRACEPARENT.exec((req.header('traceparent') ?? '').toLowerCase());
  const traceId = m && m[1] !== '0'.repeat(32) ? m[1]! : randomBytes(16).toString('hex');
  res.setHeader('traceparent', `00-${traceId}-${randomBytes(8).toString('hex')}-01`);
  runWithContext({ correlationId, traceId, ip: req.ip, userAgent: req.header('user-agent')?.slice(0, 300) }, next);
}
