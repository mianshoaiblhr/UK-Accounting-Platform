import { timingSafeEqual } from 'node:crypto';
import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type IORedis from 'ioredis';
import { AppError, notFound, unauthorized, type AppConfig, type MetricsRegistry } from '@uk/core';
import type { Database } from '@uk/db';
import { Public } from '../common/decorators';
import type { PlatformSnapshotCache } from '../common/platform-snapshot';
import { CONFIG, DB, METRICS, REDIS, SNAPSHOT } from '../common/tokens';

const sameToken = (given: string | undefined, expected: string | undefined): boolean => {
  if (!given || !expected) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};
const bearer = (req: Request) => /^Bearer (.+)$/.exec(req.header('authorization') ?? '')?.[1];

@Controller()
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Database, @Inject(REDIS) private readonly redis: IORedis, @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(METRICS) private readonly metrics: MetricsRegistry, @Inject(SNAPSHOT) private readonly snapshot: PlatformSnapshotCache,
  ) {}

  /** Liveness: the process is up. No dependencies on purpose (a database outage must not restart healthy tasks). */
  @Public() @Get('healthz')
  live() { return { status: 'ok' }; }

  /**
   * Readiness: 503 only when a dependency the API cannot serve without (database, Redis) is down. "degraded" (still 200) reports
   * background trouble - outbox lag beyond the threshold, FAILED outbox events, DEAD jobs - which alarms handle; taking healthy API tasks
   * out of rotation for a stuck worker would make the incident worse. Figures are shown only to the holder of the metrics token.
   */
  @Public() @Get('readyz')
  async ready(@Req() req: Request) {
    const checks: Record<string, string> = {};
    try { await this.db.ping(); checks.database = 'ok'; } catch { checks.database = 'fail'; }
    try { await this.redis.ping(); checks.redis = 'ok'; } catch { checks.redis = 'fail'; }
    if (Object.values(checks).includes('fail')) throw new AppError(503, 'not_ready', 'Dependency unavailable', checks);
    const degraded: string[] = [];
    let figures: Record<string, number> | undefined;
    try {
      const s = await this.snapshot.get();
      if (s.outbox.oldestUnprocessedAgeSeconds > this.config.READINESS_OUTBOX_LAG_SECONDS) degraded.push('outbox_lag');
      if (s.outbox.failed > 0) degraded.push('outbox_failed');
      if ((s.jobs.DEAD ?? 0) > 0) degraded.push('dead_jobs');
      figures = { outboxLagSeconds: Math.round(s.outbox.oldestUnprocessedAgeSeconds), outboxPending: s.outbox.pending, outboxFailed: s.outbox.failed, jobsDead: s.jobs.DEAD ?? 0, jobsFailed: s.jobs.FAILED ?? 0, jobsQueued: s.jobs.QUEUED ?? 0, remindersDue: s.remindersDue };
      checks.platform = 'ok';
    } catch { checks.platform = 'unknown'; }
    return { status: degraded.length ? 'degraded' : 'ok', checks, degraded, ...(sameToken(bearer(req), this.config.METRICS_TOKEN) ? { figures } : {}) };
  }

  /** Prometheus scrape endpoint. Disabled (404) unless METRICS_TOKEN is configured; always needs the bearer token. */
  @Public() @Get('metrics')
  async scrape(@Req() req: Request, @Res() res: Response) {
    if (!this.config.METRICS_TOKEN) throw notFound('Not found');
    if (!sameToken(bearer(req), this.config.METRICS_TOKEN)) throw unauthorized('Invalid metrics token');
    try { await this.snapshot.get(); } catch { /* serve what we have; the failure shows in readiness */ }
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(this.metrics.renderPrometheus());
  }
}
