import { Controller, Get, Inject } from '@nestjs/common';
import type IORedis from 'ioredis';
import { AppError } from '@uk/core';
import type { Database } from '@uk/db';
import { Public } from '../common/decorators';
import { DB, REDIS } from '../common/tokens';

@Controller()
export class HealthController {
  constructor(@Inject(DB) private readonly db: Database, @Inject(REDIS) private readonly redis: IORedis) {}

  @Public() @Get('healthz')
  live() { return { status: 'ok' }; }

  @Public() @Get('readyz')
  async ready() {
    const checks: Record<string, string> = {};
    try { await this.db.ping(); checks.database = 'ok'; } catch { checks.database = 'fail'; }
    try { await this.redis.ping(); checks.redis = 'ok'; } catch { checks.redis = 'fail'; }
    if (Object.values(checks).includes('fail')) throw new AppError(503, 'not_ready', 'Dependency unavailable', checks);
    return { status: 'ok', checks };
  }
}
