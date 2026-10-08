import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { z } from 'zod';
import { JobTypes, enqueueEchoSchema, paginationSchema } from '@uk/contracts';
import { notFound } from '@uk/core';
import type { Database } from '@uk/db';
import type { JobProducer } from '@uk/jobs';
import { AuditService } from '../audit/audit.service';
import { Idempotent, Org, RequirePermissions } from '../common/decorators';
import { DB, JOBS } from '../common/tokens';
import type { OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';

const view = (r: Record<string, any>) => ({
  id: r.id, type: r.type, queue: r.queue, status: r.status, progress: r.progress, progressMessage: r.progressMessage,
  attempts: r.attempts, maxAttempts: r.maxAttempts, error: r.error, correlationId: r.correlationId,
  createdAt: r.createdAt, startedAt: r.startedAt, finishedAt: r.finishedAt, result: r.result,
  // payload is intentionally never returned (may be sensitive)
});

@Controller('organisations/:organisationId/jobs')
export class JobsController {
  constructor(@Inject(DB) private readonly db: Database, @Inject(JOBS) private readonly jobs: JobProducer, private readonly audit: AuditService) {}

  @Get() @RequirePermissions('job:read')
  async list(@Org() org: OrgAccess, @Query(new ZodPipe(paginationSchema)) q: z.output<typeof paginationSchema>) {
    const rows = await this.db.tenant({ organisationId: org.organisationId, userId: org.userId }, (tx) => tx.jobRecord.findMany({
      orderBy: { id: 'desc' }, take: q.limit + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    }));
    return { items: rows.slice(0, q.limit).map(view), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null };
  }

  @Get(':jobId') @RequirePermissions('job:read')
  async get(@Org() org: OrgAccess, @Param('jobId', ParseUUIDPipe) id: string) {
    const r = await this.db.tenant({ organisationId: org.organisationId, userId: org.userId }, (tx) => tx.jobRecord.findUnique({ where: { id } }));
    if (!r) throw notFound('Job not found');
    return view(r);
  }

  @Post(':jobId/retry') @HttpCode(202) @RequirePermissions('job:manage')
  async retry(@Org() org: OrgAccess, @Param('jobId', ParseUUIDPipe) id: string) {
    const r = await this.jobs.retry(org.organisationId, org.userId, id);
    await this.audit.record({ action: 'job.retried', organisationId: org.organisationId, actorUserId: org.userId, entityType: 'job', entityId: id });
    return view(r);
  }

  /** Smoke-test endpoint for the job infrastructure (exercises retries/backoff/DLQ). */
  @Post('echo') @HttpCode(202) @RequirePermissions('job:manage') @Idempotent()
  async echo(@Org() org: OrgAccess, @Body(new ZodPipe(enqueueEchoSchema)) b: z.output<typeof enqueueEchoSchema>) {
    const { record } = await this.jobs.enqueue(JobTypes.systemEcho, { message: b.message, failTimes: b.failTimes, permanent: false }, { organisationId: org.organisationId, userId: org.userId });
    return view(record);
  }
}
