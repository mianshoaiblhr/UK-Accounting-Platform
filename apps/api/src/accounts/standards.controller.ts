import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import type { z } from 'zod';
import {
  cashFlowQuerySchema, createCashFlowClassSchema, createCashFlowMapEntrySchema, updateCashFlowClassSchema, updateCashFlowMapEntrySchema,
  createDisclosureRuleSchema, createMapEntrySchema, createStandardSchema, createStandardVersionSchema, createStatutoryLineSchema, createValidationRuleSchema, endStatutoryOverrideSchema,
  setReportingFrameworkSchema, setStatutoryOverrideSchema, statutoryOverrideListQuerySchema, statutoryPreviewQuerySchema, supersedeStandardVersionSchema, updateDisclosureRuleSchema,
  updateMapEntrySchema, updateStandardVersionSchema, updateStatutoryLineSchema, updateValidationRuleSchema, verifyStandardVersionSchema, type Permission,
} from '@uk/contracts';
import type { Database, Tx } from '@uk/db';
import { CashFlowService, FrameworkService, StandardsService, StatutoryReportService, type RuleActor } from '@uk/accounting';
import { Idempotent, Org, RequireFeature, RequirePermissions } from '../common/decorators';
import { DB } from '../common/tokens';
import type { OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';

const ID = (n: string) => Param(n, ParseUUIDPipe);
type In<S extends z.ZodTypeAny> = z.output<S>;

@Injectable()
export class AccountsApiService {
  constructor(@Inject(DB) private readonly db: Database) {}
  run<T>(org: OrgAccess, companyId: string, fn: (tx: Tx, ctx: { organisationId: string; companyId: string; actor: RuleActor }) => Promise<T>) {
    const actor: RuleActor = { userId: org.userId, kind: 'USER', can: (p, c) => org.access.can(p as Permission, { companyId: c }) };
    return this.db.tenant({ organisationId: org.organisationId, userId: org.userId }, (tx) => fn(tx, { organisationId: org.organisationId, companyId, actor }));
  }
}

/**
 * V2-M1 reporting framework (DEC-052, DEC-053, DEC-055): standards and versions with their content (authored with accounts:rules-manage while
 * unverified, verified by another person with accounts:rule-verify), the framework of each financial year and account overrides (accounts:prepare),
 * and the statutory preview (ledger:read). Behind `accounts.production`.
 */
@Controller('organisations/:organisationId/companies/:companyId')
@RequireFeature('accounts.production')
export class StandardsController {
  constructor(private readonly api: AccountsApiService, private readonly standards: StandardsService, private readonly frameworks: FrameworkService, private readonly report: StatutoryReportService,
    private readonly cashFlow: CashFlowService) {}

  // ───── Standards and versions ─────
  @Get('reporting-standards') @RequirePermissions('ledger:read')
  list(@Org() org: OrgAccess, @ID('companyId') c: string) { return this.api.run(org, c, (tx) => this.standards.listStandards(tx)); }
  @Post('reporting-standards') @RequirePermissions('accounts:rules-manage') @Idempotent()
  create(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(createStandardSchema)) b: In<typeof createStandardSchema>) { return this.api.run(org, c, (tx, x) => this.standards.createStandard(tx, { ...x, ...b })); }
  @Get('reporting-standards/:standardId/versions') @RequirePermissions('ledger:read')
  versions(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('standardId') id: string) { return this.api.run(org, c, (tx) => this.standards.listVersions(tx, id)); }
  @Post('reporting-standards/:standardId/versions') @RequirePermissions('accounts:rules-manage') @Idempotent()
  createVersion(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('standardId') id: string, @Body(new ZodPipe(createStandardVersionSchema)) b: In<typeof createStandardVersionSchema>) {
    return this.api.run(org, c, (tx, x) => this.standards.createVersion(tx, { ...x, standardId: id, ...b }));
  }
  @Get('reporting-standard-versions/:versionId') @RequirePermissions('ledger:read')
  version(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('versionId') id: string) { return this.api.run(org, c, (tx) => this.standards.getVersion(tx, id)); }
  @Patch('reporting-standard-versions/:versionId') @RequirePermissions('accounts:rules-manage')
  updateVersion(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('versionId') id: string, @Body(new ZodPipe(updateStandardVersionSchema)) b: In<typeof updateStandardVersionSchema>) {
    return this.api.run(org, c, (tx, x) => this.standards.updateVersion(tx, { ...x, id, ...b }));
  }
  @Post('reporting-standard-versions/:versionId/verify') @HttpCode(200) @RequirePermissions('accounts:rule-verify') @Idempotent()
  verify(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('versionId') id: string, @Body(new ZodPipe(verifyStandardVersionSchema)) b: In<typeof verifyStandardVersionSchema>) {
    return this.api.run(org, c, (tx, x) => this.standards.verify(tx, { ...x, id, ...b }));
  }
  @Post('reporting-standard-versions/:versionId/supersede') @RequirePermissions('accounts:rules-manage') @Idempotent()
  supersede(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('versionId') id: string, @Body(new ZodPipe(supersedeStandardVersionSchema)) b: In<typeof supersedeStandardVersionSchema>) {
    return this.api.run(org, c, (tx, x) => this.standards.supersede(tx, { ...x, id, ...b }));
  }

  // ───── Version content (while unverified) ─────
  @Post('reporting-standard-versions/:versionId/lines') @RequirePermissions('accounts:rules-manage') @Idempotent()
  addLine(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('versionId') v: string, @Body(new ZodPipe(createStatutoryLineSchema)) b: In<typeof createStatutoryLineSchema>) {
    return this.api.run(org, c, (tx, x) => this.standards.addLine(tx, { ...x, versionId: v, ...b }));
  }
  @Patch('reporting-standard-versions/:versionId/lines/:lineId') @RequirePermissions('accounts:rules-manage')
  updateLine(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('versionId') v: string, @ID('lineId') id: string, @Body(new ZodPipe(updateStatutoryLineSchema)) b: In<typeof updateStatutoryLineSchema>) {
    return this.api.run(org, c, (tx, x) => this.standards.updateLine(tx, { ...x, versionId: v, id, ...b }));
  }
  @Delete('reporting-standard-versions/:versionId/lines/:lineId') @HttpCode(200) @RequirePermissions('accounts:rules-manage')
  removeLine(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('versionId') v: string, @ID('lineId') id: string) { return this.api.run(org, c, (tx, x) => this.standards.removeLine(tx, { ...x, versionId: v, id })); }
  @Post('reporting-standard-versions/:versionId/map-entries') @RequirePermissions('accounts:rules-manage') @Idempotent()
  addMap(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('versionId') v: string, @Body(new ZodPipe(createMapEntrySchema)) b: In<typeof createMapEntrySchema>) {
    return this.api.run(org, c, (tx, x) => this.standards.addMapEntry(tx, { ...x, versionId: v, ...b }));
  }
  @Patch('reporting-standard-versions/:versionId/map-entries/:entryId') @RequirePermissions('accounts:rules-manage')
  updateMap(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('versionId') v: string, @ID('entryId') id: string, @Body(new ZodPipe(updateMapEntrySchema)) b: In<typeof updateMapEntrySchema>) {
    return this.api.run(org, c, (tx, x) => this.standards.updateMapEntry(tx, { ...x, versionId: v, id, ...b }));
  }
  @Delete('reporting-standard-versions/:versionId/map-entries/:entryId') @HttpCode(200) @RequirePermissions('accounts:rules-manage')
  removeMap(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('versionId') v: string, @ID('entryId') id: string) { return this.api.run(org, c, (tx, x) => this.standards.removeMapEntry(tx, { ...x, versionId: v, id })); }
  @Post('reporting-standard-versions/:versionId/validation-rules') @RequirePermissions('accounts:rules-manage') @Idempotent()
  addRule(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('versionId') v: string, @Body(new ZodPipe(createValidationRuleSchema)) b: In<typeof createValidationRuleSchema>) {
    return this.api.run(org, c, (tx, x) => this.standards.addValidationRule(tx, { ...x, versionId: v, ...b }));
  }
  @Patch('reporting-standard-versions/:versionId/validation-rules/:ruleId') @RequirePermissions('accounts:rules-manage')
  updateRule(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('versionId') v: string, @ID('ruleId') id: string, @Body(new ZodPipe(updateValidationRuleSchema)) b: In<typeof updateValidationRuleSchema>) {
    return this.api.run(org, c, (tx, x) => this.standards.updateValidationRule(tx, { ...x, versionId: v, id, ...b }));
  }
  @Delete('reporting-standard-versions/:versionId/validation-rules/:ruleId') @HttpCode(200) @RequirePermissions('accounts:rules-manage')
  removeRule(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('versionId') v: string, @ID('ruleId') id: string) { return this.api.run(org, c, (tx, x) => this.standards.removeValidationRule(tx, { ...x, versionId: v, id })); }
  @Post('reporting-standard-versions/:versionId/disclosure-rules') @RequirePermissions('accounts:rules-manage') @Idempotent()
  addNote(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('versionId') v: string, @Body(new ZodPipe(createDisclosureRuleSchema)) b: In<typeof createDisclosureRuleSchema>) {
    return this.api.run(org, c, (tx, x) => this.standards.addDisclosureRule(tx, { ...x, versionId: v, ...b }));
  }
  @Patch('reporting-standard-versions/:versionId/disclosure-rules/:ruleId') @RequirePermissions('accounts:rules-manage')
  updateNote(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('versionId') v: string, @ID('ruleId') id: string, @Body(new ZodPipe(updateDisclosureRuleSchema)) b: In<typeof updateDisclosureRuleSchema>) {
    return this.api.run(org, c, (tx, x) => this.standards.updateDisclosureRule(tx, { ...x, versionId: v, id, ...b }));
  }
  @Delete('reporting-standard-versions/:versionId/disclosure-rules/:ruleId') @HttpCode(200) @RequirePermissions('accounts:rules-manage')
  removeNote(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('versionId') v: string, @ID('ruleId') id: string) { return this.api.run(org, c, (tx, x) => this.standards.removeDisclosureRule(tx, { ...x, versionId: v, id })); }

  // V2-M5c (DEC-067): cash-flow classes and the map to them or to cash
  @Post('reporting-standard-versions/:versionId/cash-flow-classes') @RequirePermissions('accounts:rules-manage') @Idempotent()
  addCashClass(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('versionId') v: string, @Body(new ZodPipe(createCashFlowClassSchema)) b: In<typeof createCashFlowClassSchema>) {
    return this.api.run(org, c, (tx, x) => this.standards.addCashFlowClass(tx, { ...x, versionId: v, ...b }));
  }
  @Patch('reporting-standard-versions/:versionId/cash-flow-classes/:classId') @RequirePermissions('accounts:rules-manage')
  updateCashClass(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('versionId') v: string, @ID('classId') id: string, @Body(new ZodPipe(updateCashFlowClassSchema)) b: In<typeof updateCashFlowClassSchema>) {
    return this.api.run(org, c, (tx, x) => this.standards.updateCashFlowClass(tx, { ...x, versionId: v, id, ...b }));
  }
  @Delete('reporting-standard-versions/:versionId/cash-flow-classes/:classId') @HttpCode(200) @RequirePermissions('accounts:rules-manage')
  removeCashClass(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('versionId') v: string, @ID('classId') id: string) { return this.api.run(org, c, (tx, x) => this.standards.removeCashFlowClass(tx, { ...x, versionId: v, id })); }
  @Post('reporting-standard-versions/:versionId/cash-flow-map-entries') @RequirePermissions('accounts:rules-manage') @Idempotent()
  addCashMap(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('versionId') v: string, @Body(new ZodPipe(createCashFlowMapEntrySchema)) b: In<typeof createCashFlowMapEntrySchema>) {
    return this.api.run(org, c, (tx, x) => this.standards.addCashFlowMapEntry(tx, { ...x, versionId: v, ...b }));
  }
  @Patch('reporting-standard-versions/:versionId/cash-flow-map-entries/:entryId') @RequirePermissions('accounts:rules-manage')
  updateCashMap(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('versionId') v: string, @ID('entryId') id: string, @Body(new ZodPipe(updateCashFlowMapEntrySchema)) b: In<typeof updateCashFlowMapEntrySchema>) {
    return this.api.run(org, c, (tx, x) => this.standards.updateCashFlowMapEntry(tx, { ...x, versionId: v, id, ...b }));
  }
  @Delete('reporting-standard-versions/:versionId/cash-flow-map-entries/:entryId') @HttpCode(200) @RequirePermissions('accounts:rules-manage')
  removeCashMap(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('versionId') v: string, @ID('entryId') id: string) { return this.api.run(org, c, (tx, x) => this.standards.removeCashFlowMapEntry(tx, { ...x, versionId: v, id })); }

  // ───── Per company ─────
  @Get('reporting-frameworks') @RequirePermissions('ledger:read')
  frameworksList(@Org() org: OrgAccess, @ID('companyId') c: string) { return this.api.run(org, c, (tx) => this.frameworks.list(tx, c)); }
  @Put('reporting-frameworks') @RequirePermissions('accounts:prepare')
  setFramework(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(setReportingFrameworkSchema)) b: In<typeof setReportingFrameworkSchema>) { return this.api.run(org, c, (tx, x) => this.frameworks.set(tx, { ...x, ...b })); }
  @Get('statutory-overrides') @RequirePermissions('ledger:read')
  overrides(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(statutoryOverrideListQuerySchema)) q: In<typeof statutoryOverrideListQuerySchema>) { return this.api.run(org, c, (tx) => this.frameworks.listOverrides(tx, c, q)); }
  @Post('statutory-overrides') @RequirePermissions('accounts:prepare') @Idempotent()
  setOverride(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(setStatutoryOverrideSchema)) b: In<typeof setStatutoryOverrideSchema>) { return this.api.run(org, c, (tx, x) => this.frameworks.setOverride(tx, { ...x, ...b })); }
  @Post('statutory-overrides/:overrideId/end') @HttpCode(200) @RequirePermissions('accounts:prepare') @Idempotent()
  endOverride(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('overrideId') id: string, @Body(new ZodPipe(endStatutoryOverrideSchema)) b: In<typeof endStatutoryOverrideSchema>) {
    return this.api.run(org, c, (tx, x) => this.frameworks.endOverride(tx, { ...x, id, ...b }));
  }
  @Get('statutory-preview') @RequirePermissions('ledger:read')
  preview(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(statutoryPreviewQuerySchema)) q: In<typeof statutoryPreviewQuerySchema>) { return this.api.run(org, c, (tx) => this.report.preview(tx, c, q)); }
  @Get('cash-flow') @RequirePermissions('ledger:read')
  cashFlowStatement(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(cashFlowQuerySchema)) q: In<typeof cashFlowQuerySchema>) { return this.api.run(org, c, (tx) => this.cashFlow.statement(tx, c, q)); }
}
