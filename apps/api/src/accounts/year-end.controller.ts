import { Body, Controller, Get, HttpCode, Inject, Injectable, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { z } from 'zod';
import {
  cancelYearEndItemSchema, createProvisionSchema, createYearEndItemSchema, provisionMovementSchema, provisionReportQuerySchema, releasePreviewQuerySchema, releaseRunSchema, reverseProvisionMovementSchema,
  reverseReleaseRunSchema, reverseYearEndCloseSchema, yearEndCloseListQuerySchema, yearEndClosePreviewQuerySchema, yearEndCloseSchema, yearEndItemListQuerySchema, yearEndRegisterQuerySchema, type Permission,
} from '@uk/contracts';
import type { Database, Tx } from '@uk/db';
import { YearEndCloseService, YearEndService, type PostingActor } from '@uk/accounting';
import { Idempotent, Org, RequireFeature, RequirePermissions } from '../common/decorators';
import { DB } from '../common/tokens';
import type { OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';

const ID = (n: string) => Param(n, ParseUUIDPipe);
type In<S extends z.ZodTypeAny> = z.output<S>;

@Injectable()
export class YearEndApiService {
  constructor(@Inject(DB) private readonly db: Database) {}
  run<T>(org: OrgAccess, companyId: string, fn: (tx: Tx, ctx: { organisationId: string; companyId: string; actor: PostingActor }) => Promise<T>) {
    const actor: PostingActor = { kind: 'USER', userId: org.userId, can: (p, c) => org.access.can(p as Permission, { companyId: c }) };
    return this.db.tenant({ organisationId: org.organisationId, userId: org.userId }, (tx) => fn(tx, { organisationId: org.organisationId, companyId, actor }));
  }
}

/** V2-M3a year-end adjustments (DEC-059): accruals, accrued income, prepayments, deferred income, release runs, provisions and the register. Behind `accounts.production`. */
@Controller('organisations/:organisationId/companies/:companyId')
@RequireFeature('accounts.production')
export class YearEndController {
  constructor(private readonly api: YearEndApiService, private readonly ye: YearEndService) {}

  @Get('year-end-items') @RequirePermissions('ledger:read')
  items(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(yearEndItemListQuerySchema)) q: In<typeof yearEndItemListQuerySchema>) { return this.api.run(org, c, (tx) => this.ye.listItems(tx, c, q)); }
  @Post('year-end-items') @RequirePermissions('accounts:prepare') @Idempotent()
  create(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(createYearEndItemSchema)) b: In<typeof createYearEndItemSchema>) { return this.api.run(org, c, (tx, x) => this.ye.createItem(tx, { ...x, ...b })); }
  @Get('year-end-items/:itemId') @RequirePermissions('ledger:read')
  item(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('itemId') id: string) { return this.api.run(org, c, (tx) => this.ye.getItem(tx, c, id)); }
  @Post('year-end-items/:itemId/cancel') @HttpCode(200) @RequirePermissions('accounts:prepare') @Idempotent()
  cancel(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('itemId') id: string, @Body(new ZodPipe(cancelYearEndItemSchema)) b: In<typeof cancelYearEndItemSchema>) { return this.api.run(org, c, (tx, x) => this.ye.cancelItem(tx, { ...x, id, ...b })); }

  @Get('release-runs') @RequirePermissions('ledger:read')
  runs(@Org() org: OrgAccess, @ID('companyId') c: string) { return this.api.run(org, c, (tx) => this.ye.listRuns(tx, c)); }
  @Get('release-runs/preview') @RequirePermissions('ledger:read')
  preview(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(releasePreviewQuerySchema)) q: In<typeof releasePreviewQuerySchema>) { return this.api.run(org, c, (tx) => this.ye.previewView(tx, c, q.asAt)); }
  @Post('release-runs') @RequirePermissions('accounts:prepare') @Idempotent()
  postRun(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(releaseRunSchema)) b: In<typeof releaseRunSchema>) { return this.api.run(org, c, (tx, x) => this.ye.postRun(tx, { ...x, ...b })); }
  @Get('release-runs/:runId') @RequirePermissions('ledger:read')
  run(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('runId') id: string) { return this.api.run(org, c, (tx) => this.ye.getRun(tx, c, id)); }
  @Post('release-runs/:runId/reverse') @HttpCode(200) @RequirePermissions('accounts:prepare') @Idempotent()
  reverseRun(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('runId') id: string, @Body(new ZodPipe(reverseReleaseRunSchema)) b: In<typeof reverseReleaseRunSchema>) { return this.api.run(org, c, (tx, x) => this.ye.reverseRun(tx, { ...x, id, ...b })); }

  @Get('provisions') @RequirePermissions('ledger:read')
  provisions(@Org() org: OrgAccess, @ID('companyId') c: string) { return this.api.run(org, c, (tx) => this.ye.listProvisions(tx, c)); }
  @Post('provisions') @RequirePermissions('accounts:prepare') @Idempotent()
  createProvision(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(createProvisionSchema)) b: In<typeof createProvisionSchema>) { return this.api.run(org, c, (tx, x) => this.ye.createProvision(tx, { ...x, ...b })); }
  @Get('provisions/report') @RequirePermissions('ledger:read')
  report(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(provisionReportQuerySchema)) q: In<typeof provisionReportQuerySchema>) { return this.api.run(org, c, (tx) => this.ye.provisionReport(tx, c, q)); }
  @Get('provisions/:provisionId') @RequirePermissions('ledger:read')
  provision(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('provisionId') id: string) { return this.api.run(org, c, (tx) => this.ye.getProvision(tx, c, id)); }
  @Post('provisions/:provisionId/movements') @RequirePermissions('accounts:prepare') @Idempotent()
  move(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('provisionId') id: string, @Body(new ZodPipe(provisionMovementSchema)) b: In<typeof provisionMovementSchema>) {
    return this.api.run(org, c, (tx, x) => this.ye.addMovement(tx, { ...x, provisionId: id, ...b }));
  }
  @Post('provision-movements/:movementId/reverse') @HttpCode(200) @RequirePermissions('accounts:prepare') @Idempotent()
  reverseMove(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('movementId') id: string, @Body(new ZodPipe(reverseProvisionMovementSchema)) b: In<typeof reverseProvisionMovementSchema>) {
    return this.api.run(org, c, (tx, x) => this.ye.reverseMovement(tx, { ...x, id, ...b }));
  }
  @Get('year-end-register') @RequirePermissions('ledger:read')
  register(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(yearEndRegisterQuerySchema)) q: In<typeof yearEndRegisterQuerySchema>) { return this.api.run(org, c, (tx) => this.ye.register(tx, c, q.asAt)); }
}

/** V2-M3b closing journal (DEC-060): preview, close, list, get and reverse a financial year's close to retained earnings. Behind `accounts.production`. */
@Controller('organisations/:organisationId/companies/:companyId/year-end-closes')
@RequireFeature('accounts.production')
export class YearEndCloseController {
  constructor(private readonly api: YearEndApiService, private readonly closes: YearEndCloseService) {}

  @Get() @RequirePermissions('ledger:read')
  list(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(yearEndCloseListQuerySchema)) q: In<typeof yearEndCloseListQuerySchema>) { return this.api.run(org, c, (tx) => this.closes.list(tx, c, q)); }
  @Get('preview') @RequirePermissions('ledger:read')
  preview(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(yearEndClosePreviewQuerySchema)) q: In<typeof yearEndClosePreviewQuerySchema>) { return this.api.run(org, c, (tx) => this.closes.preview(tx, c, q)); }
  @Post() @RequirePermissions('accounts:prepare') @Idempotent()
  close(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(yearEndCloseSchema)) b: In<typeof yearEndCloseSchema>) { return this.api.run(org, c, (tx, x) => this.closes.close(tx, { ...x, ...b })); }
  @Get(':closeId') @RequirePermissions('ledger:read')
  get(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('closeId') id: string) { return this.api.run(org, c, (tx) => this.closes.get(tx, c, id)); }
  @Post(':closeId/reverse') @HttpCode(200) @RequirePermissions('accounts:prepare') @Idempotent()
  reverse(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('closeId') id: string, @Body(new ZodPipe(reverseYearEndCloseSchema)) b: In<typeof reverseYearEndCloseSchema>) { return this.api.run(org, c, (tx, x) => this.closes.reverse(tx, { ...x, id, ...b })); }
}
