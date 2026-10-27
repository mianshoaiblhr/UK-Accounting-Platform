import { Body, Controller, Get, HttpCode, Inject, Injectable, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  companyObligationQuerySchema, complianceProfileSchema, createDeadlineRuleSchema, createObligationSchema, generateObligationsSchema, obligationListQuerySchema,
  supersedeDeadlineRuleSchema, updateObligationSchema, verifyDeadlineRuleSchema, type Permission,
} from '@uk/contracts';
import type { Database, Tx } from '@uk/db';
import { ComplianceService, type ComplianceActor } from '@uk/accounting';
import { Idempotent, Org, RequireFeature, RequirePermissions } from '../common/decorators';
import { DB } from '../common/tokens';
import type { OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';

const ID = (n: string) => Param(n, ParseUUIDPipe);
const ruleListQuery = z.object({ includeSuperseded: z.enum(['true', 'false']).optional().transform((v) => v === 'true') }).strict();

@Injectable()
export class ComplianceApiService {
  constructor(@Inject(DB) private readonly db: Database) {}
  actor(org: OrgAccess): ComplianceActor {
    return {
      userId: org.userId, kind: 'USER',
      can: (p, companyId) => org.access.can(p as Permission, companyId ? { companyId } : {}),
      canReadDocument: (d) => org.access.canReadDocument({ ...d, createdByUserId: d.createdByUserId ?? '' }),
    };
  }
  run<T>(org: OrgAccess, fn: (tx: Tx, a: ComplianceActor) => Promise<T>) {
    return this.db.tenant({ organisationId: org.organisationId, userId: org.userId }, (tx) => fn(tx, this.actor(org)));
  }
}

/** V7-M1 (DEC-088): deadline rules (organisation data) and the practice-wide deadline views, which cover only the clients the caller may read. */
@Controller('organisations/:organisationId/compliance')
@RequireFeature('practice.management')
export class ComplianceController {
  constructor(private readonly api: ComplianceApiService, private readonly svc: ComplianceService) {}

  @Get('deadline-rules') @RequirePermissions('org:read')
  rules(@Org() org: OrgAccess, @Query(new ZodPipe(ruleListQuery)) q: z.output<typeof ruleListQuery>) { return this.api.run(org, (tx) => this.svc.listRules(tx, q)); }
  @Post('deadline-rules') @RequirePermissions('compliance:rules-manage') @Idempotent()
  addRule(@Org() org: OrgAccess, @Body(new ZodPipe(createDeadlineRuleSchema)) b: z.output<typeof createDeadlineRuleSchema>) {
    return this.api.run(org, (tx, actor) => this.svc.addRule(tx, { organisationId: org.organisationId, actor, ...b }));
  }
  @Post('deadline-rules/:ruleId/supersede') @RequirePermissions('compliance:rules-manage') @Idempotent()
  supersede(@Org() org: OrgAccess, @ID('ruleId') id: string, @Body(new ZodPipe(supersedeDeadlineRuleSchema)) b: z.output<typeof supersedeDeadlineRuleSchema>) {
    return this.api.run(org, (tx, actor) => this.svc.supersedeRule(tx, { organisationId: org.organisationId, actor, id, ...b }));
  }
  @Post('deadline-rules/:ruleId/verify') @HttpCode(200) @RequirePermissions('compliance:rule-verify') @Idempotent()
  verify(@Org() org: OrgAccess, @ID('ruleId') id: string, @Body(new ZodPipe(verifyDeadlineRuleSchema)) b: z.output<typeof verifyDeadlineRuleSchema>) {
    return this.api.run(org, (tx, actor) => this.svc.verifyRule(tx, { organisationId: org.organisationId, actor, id, ...b }));
  }

  @Get('obligations') @RequirePermissions('compliance:read')
  async obligations(@Org() org: OrgAccess, @Query(new ZodPipe(obligationListQuerySchema)) q: z.output<typeof obligationListQuerySchema>) {
    const ids = await org.access.companyIds('compliance:read');
    const assigneeUserId = q.assignee === 'me' ? org.userId : q.assignee;
    return this.api.run(org, (tx) => this.svc.listForPractice(tx, ids, { ...q, assigneeUserId }));
  }
  @Get('summary') @RequirePermissions('compliance:read')
  async summary(@Org() org: OrgAccess) {
    const ids = await org.access.companyIds('compliance:read');
    return this.api.run(org, (tx) => this.svc.summary(tx, ids));
  }
}

/** V7-M1 (DEC-088): one client's obligations, their generation from verified rules, and its compliance profile. */
@Controller('organisations/:organisationId/companies/:companyId/compliance')
@RequireFeature('practice.management')
export class CompanyComplianceController {
  constructor(private readonly api: ComplianceApiService, private readonly svc: ComplianceService) {}

  @Get('profile') @RequirePermissions('compliance:read')
  profile(@Org() org: OrgAccess, @ID('companyId') c: string) { return this.api.run(org, (tx) => this.svc.getProfile(tx, c)); }
  @Put('profile') @RequirePermissions('compliance:manage')
  setProfile(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(complianceProfileSchema)) b: z.output<typeof complianceProfileSchema>) {
    return this.api.run(org, (tx, actor) => this.svc.setProfile(tx, { organisationId: org.organisationId, companyId: c, actor, ...b }));
  }
  @Post('generate') @HttpCode(200) @RequirePermissions('compliance:manage') @Idempotent()
  generate(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(generateObligationsSchema)) b: z.output<typeof generateObligationsSchema>) {
    return this.api.run(org, (tx, actor) => this.svc.generate(tx, { organisationId: org.organisationId, companyId: c, actor, ...b }));
  }
  @Get('obligations') @RequirePermissions('compliance:read')
  list(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(companyObligationQuerySchema)) q: z.output<typeof companyObligationQuerySchema>) {
    return this.api.run(org, (tx) => this.svc.listForCompany(tx, c, q));
  }
  @Post('obligations') @RequirePermissions('compliance:manage') @Idempotent()
  create(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(createObligationSchema)) b: z.output<typeof createObligationSchema>) {
    return this.api.run(org, (tx, actor) => this.svc.create(tx, { organisationId: org.organisationId, companyId: c, actor, ...b }));
  }
  @Get('obligations/:obligationId') @RequirePermissions('compliance:read')
  get(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('obligationId') id: string) { return this.api.run(org, (tx) => this.svc.get(tx, c, id)); }
  @Patch('obligations/:obligationId') @RequirePermissions('compliance:manage')
  update(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('obligationId') id: string, @Body(new ZodPipe(updateObligationSchema)) b: z.output<typeof updateObligationSchema>) {
    return this.api.run(org, (tx, actor) => this.svc.update(tx, { organisationId: org.organisationId, companyId: c, actor, id, ...b }));
  }
}
