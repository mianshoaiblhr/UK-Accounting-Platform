import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { JobTypes, decideProposalSchema, paginationSchema, requestAiSuggestionSchema } from '@uk/contracts';
import { AppError, notFound } from '@uk/core';
import type { Database } from '@uk/db';
import type { JobProducer } from '@uk/jobs';
import type { AiGateway, AiProposalService } from '@uk/platform';
import { Idempotent, Org, RequirePermissions } from '../common/decorators';
import { AI_GATEWAY, AI_PROPOSALS, DB, JOBS } from '../common/tokens';
import type { OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';

const listQuery = paginationSchema.extend({ status: z.enum(['SUGGESTED', 'UNDER_REVIEW', 'ACCEPTED', 'REJECTED']).optional() });

@Controller('organisations/:organisationId/ai')
export class AiController {
  constructor(
    @Inject(DB) private readonly db: Database, @Inject(JOBS) private readonly jobs: JobProducer,
    @Inject(AI_GATEWAY) private readonly gateway: AiGateway, @Inject(AI_PROPOSALS) private readonly proposals: AiProposalService,
  ) {}
  private ctx(org: OrgAccess) { return { organisationId: org.organisationId, userId: org.userId }; }

  /** Asynchronous by design: the model call happens in the worker; the result is a PROPOSAL awaiting human review. */
  @Post('suggestions') @HttpCode(202) @RequirePermissions('ai:use') @Idempotent()
  async suggest(@Org() org: OrgAccess, @Body(new ZodPipe(requestAiSuggestionSchema)) b: z.output<typeof requestAiSuggestionSchema>) {
    if (!this.gateway.available) throw new AppError(503, 'ai_unavailable', 'No AI provider is configured');
    await org.access.requireResource('ai:use', b.companyId ?? null, 'Company not found');
    const { record } = await this.jobs.enqueue(JobTypes.aiSuggest, { purpose: b.purpose, input: b.input, companyId: b.companyId }, { organisationId: org.organisationId, userId: org.userId });
    return { jobId: record.id, status: record.status };
  }

  @Get('proposals') @RequirePermissions('ai:use')
  async list(@Org() org: OrgAccess, @Query(new ZodPipe(listQuery)) q: z.output<typeof listQuery>) {
    const visible = await org.access.companyWhere('ai:use');
    const rows = await this.db.tenant(this.ctx(org), (tx) => tx.aiProposal.findMany({
      where: { ...visible, ...(q.status ? { status: q.status } : {}) }, orderBy: { id: 'desc' }, take: q.limit + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}) }));
    return { items: rows.slice(0, q.limit), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null };
  }

  @Get('proposals/:proposalId') @RequirePermissions('ai:use')
  async get(@Org() org: OrgAccess, @Param('proposalId', ParseUUIDPipe) id: string) {
    const p = await this.db.tenant(this.ctx(org), (tx) => tx.aiProposal.findUnique({ where: { id } }));
    if (!p) throw notFound('Proposal not found');
    await org.access.requireResource('ai:use', p.companyId, 'Proposal not found');
    return p;
  }

  /** A human takes the suggestion into review (SUGGESTED -> UNDER_REVIEW). */
  @Post('proposals/:proposalId/review') @HttpCode(200) @RequirePermissions('ai:approve')
  async review(@Org() org: OrgAccess, @Param('proposalId', ParseUUIDPipe) id: string) {
    await this.get(org, id);
    return this.db.tenant(this.ctx(org), (tx) => this.proposals.beginReview(tx, { organisationId: org.organisationId, proposalId: id, actor: org.access.actor() }));
  }

  /** ACCEPT or REJECT. Accepting records the human decision only; applying it is the owning module's authorised workflow. */
  @Post('proposals/:proposalId/decision') @HttpCode(200) @RequirePermissions('ai:approve')
  async decide(@Org() org: OrgAccess, @Param('proposalId', ParseUUIDPipe) id: string, @Body(new ZodPipe(decideProposalSchema)) b: z.output<typeof decideProposalSchema>) {
    await this.get(org, id);
    return this.db.tenant(this.ctx(org), (tx) => this.proposals.decide(tx, { organisationId: org.organisationId, proposalId: id, decision: b.decision, comment: b.comment, actor: org.access.actor() }));
  }
}
