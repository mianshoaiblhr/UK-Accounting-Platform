import type { NextFunction, Request, Response } from 'express';
import { getContext, type AppConfig, type Logger, type MetricsRegistry } from '@uk/core';

const statusClass = (s: number) => `${Math.floor(s / 100)}xx`;
/** Probes and scrapes are logged at debug: they are frequent and say nothing about users. */
const QUIET = /^\/api\/v1\/(healthz|readyz|metrics)$/;
const LOGIN = '/api/v1/auth/login';

/**
 * One structured access-log line and the HTTP metrics per request (ADR-35). Uses the ROUTE TEMPLATE (`/…/tasks/:taskId`), never the concrete
 * path or query string, so ids and tokens cannot reach the log or a metric label. No bodies, no headers. IP and user agent are included only
 * when device metadata capture is on (the same lawful-basis switch as the audit trail). Must never throw or slow a request.
 */
export function accessLog(logger: Logger, metrics: MetricsRegistry, config: Pick<AppConfig, 'AUDIT_CAPTURE_DEVICE_METADATA'>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const started = process.hrtime.bigint();
    const ctx = getContext(); // the store object is mutated as the request is authenticated; read it when the response finishes
    res.once('finish', () => {
      try {
        const seconds = Number(process.hrtime.bigint() - started) / 1e9;
        const route = req.route?.path ? `${req.baseUrl ?? ''}${String(req.route.path)}` : 'unmatched';
        const status = res.statusCode;
        const labels = { method: req.method, route, status_class: statusClass(status) };
        metrics.inc('http_requests_total', 'HTTP requests', labels);
        metrics.observe('http_request_duration_seconds', 'HTTP request latency', seconds, { method: req.method, route });
        if (route === LOGIN && (status === 401 || status === 429)) metrics.inc('auth_login_failures_total', 'Failed or throttled logins', { reason: status === 429 ? 'throttled' : 'rejected' });
        const quiet = QUIET.test(route) && status < 500;
        const level = status >= 500 ? 'error' : quiet ? 'debug' : status >= 400 ? 'warn' : 'info';
        logger[level]({
          msg: 'request', method: req.method, route, status, durationMs: Math.round(seconds * 1000), bytes: Number(res.getHeader('content-length') ?? 0) || undefined,
          correlationId: ctx?.correlationId, traceId: ctx?.traceId, userId: ctx?.userId, organisationId: ctx?.organisationId,
          ...(config.AUDIT_CAPTURE_DEVICE_METADATA ? { ip: ctx?.ip, userAgent: ctx?.userAgent } : {}),
        });
      } catch { /* observability must never break a request */ }
    });
    next();
  };
}
