import { Body, Controller, Get, HttpCode, Inject, Injectable, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type { z } from 'zod';
import {
  addAssetSchema, assetListQuerySchema, assetRegisterQuerySchema, changeAssetTaxSchema, changeEstimateSchema, createAssetClassSchema, depreciationPreviewQuerySchema, depreciationRunSchema,
  disposeAssetSchema, reverseAssetEventSchema, updateAssetClassSchema, type Permission,
} from '@uk/contracts';
import type { Database, Tx } from '@uk/db';
import { DepreciationService, FixedAssetService, type PostingActor } from '@uk/accounting';
import { Idempotent, Org, RequireFeature, RequirePermissions } from '../common/decorators';
import { DB } from '../common/tokens';
import type { OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';

const ID = (n: string) => Param(n, ParseUUIDPipe);
type In<S extends z.ZodTypeAny> = z.output<S>;

@Injectable()
export class AssetsApiService {
  constructor(@Inject(DB) private readonly db: Database) {}
  run<T>(org: OrgAccess, companyId: string, fn: (tx: Tx, ctx: { organisationId: string; companyId: string; actor: PostingActor }) => Promise<T>) {
    const actor: PostingActor = { kind: 'USER', userId: org.userId, can: (p, c) => org.access.can(p as Permission, { companyId: c }) };
    return this.db.tenant({ organisationId: org.organisationId, userId: org.userId }, (tx) => fn(tx, { organisationId: org.organisationId, companyId, actor }));
  }
}

/** V2-M2 fixed assets (DEC-058): classes, the register, changes of estimate, disposals, depreciation runs and the reconciliation to the ledger. Behind `accounts.production`. */
@Controller('organisations/:organisationId/companies/:companyId')
@RequireFeature('accounts.production')
export class FixedAssetsController {
  constructor(private readonly api: AssetsApiService, private readonly assets: FixedAssetService, private readonly depreciation: DepreciationService) {}

  @Get('fixed-asset-classes') @RequirePermissions('assets:read')
  classes(@Org() org: OrgAccess, @ID('companyId') c: string) { return this.api.run(org, c, (tx) => this.assets.listClasses(tx, c)); }
  @Post('fixed-asset-classes') @RequirePermissions('assets:manage') @Idempotent()
  createClass(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(createAssetClassSchema)) b: In<typeof createAssetClassSchema>) { return this.api.run(org, c, (tx, x) => this.assets.createClass(tx, { ...x, ...b })); }
  @Patch('fixed-asset-classes/:classId') @RequirePermissions('assets:manage')
  updateClass(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('classId') id: string, @Body(new ZodPipe(updateAssetClassSchema)) b: In<typeof updateAssetClassSchema>) {
    return this.api.run(org, c, (tx, x) => this.assets.updateClass(tx, { ...x, id, ...b }));
  }

  @Get('fixed-assets') @RequirePermissions('assets:read')
  list(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(assetListQuerySchema)) q: In<typeof assetListQuerySchema>) { return this.api.run(org, c, (tx) => this.assets.list(tx, c, q)); }
  @Post('fixed-assets') @RequirePermissions('assets:manage') @Idempotent()
  add(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(addAssetSchema)) b: In<typeof addAssetSchema>) { return this.api.run(org, c, (tx, x) => this.assets.addAsset(tx, { ...x, ...b })); }
  @Get('fixed-assets/:assetId') @RequirePermissions('assets:read')
  get(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('assetId') id: string) { return this.api.run(org, c, (tx) => this.assets.get(tx, c, id)); }
  @Post('fixed-assets/:assetId/estimate') @RequirePermissions('assets:manage') @Idempotent()
  estimate(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('assetId') id: string, @Body(new ZodPipe(changeEstimateSchema)) b: In<typeof changeEstimateSchema>) {
    return this.api.run(org, c, (tx, x) => this.assets.changeEstimate(tx, { ...x, id, ...b }));
  }
  @Post('fixed-assets/:assetId/tax') @HttpCode(200) @RequirePermissions('assets:manage') @Idempotent()
  tax(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('assetId') id: string, @Body(new ZodPipe(changeAssetTaxSchema)) b: In<typeof changeAssetTaxSchema>) { return this.api.run(org, c, (tx, x) => this.assets.changeTax(tx, { ...x, id, ...b })); }
  @Post('fixed-assets/:assetId/dispose') @HttpCode(200) @RequirePermissions('assets:manage') @Idempotent()
  dispose(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('assetId') id: string, @Body(new ZodPipe(disposeAssetSchema)) b: In<typeof disposeAssetSchema>) { return this.api.run(org, c, (tx, x) => this.assets.dispose(tx, { ...x, id, ...b })); }
  @Post('fixed-assets/:assetId/reverse-disposal') @HttpCode(200) @RequirePermissions('assets:manage') @Idempotent()
  reverseDisposal(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('assetId') id: string, @Body(new ZodPipe(reverseAssetEventSchema)) b: In<typeof reverseAssetEventSchema>) {
    return this.api.run(org, c, (tx, x) => this.assets.reverseDisposal(tx, { ...x, id, ...b }));
  }
  @Post('fixed-assets/:assetId/reverse-addition') @HttpCode(200) @RequirePermissions('assets:manage') @Idempotent()
  reverseAddition(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('assetId') id: string, @Body(new ZodPipe(reverseAssetEventSchema)) b: In<typeof reverseAssetEventSchema>) {
    return this.api.run(org, c, (tx, x) => this.assets.reverseAddition(tx, { ...x, id, ...b }));
  }
  @Get('fixed-asset-register') @RequirePermissions('assets:read')
  register(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(assetRegisterQuerySchema)) q: In<typeof assetRegisterQuerySchema>) { return this.api.run(org, c, (tx) => this.assets.register(tx, c, q.asAt)); }

  @Get('depreciation-runs') @RequirePermissions('assets:read')
  runs(@Org() org: OrgAccess, @ID('companyId') c: string) { return this.api.run(org, c, (tx) => this.depreciation.list(tx, c)); }
  @Get('depreciation-runs/preview') @RequirePermissions('assets:read')
  preview(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(depreciationPreviewQuerySchema)) q: In<typeof depreciationPreviewQuerySchema>) { return this.api.run(org, c, (tx) => this.depreciation.previewView(tx, c, q.asAt)); }
  @Post('depreciation-runs') @RequirePermissions('assets:manage') @Idempotent()
  postRun(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(depreciationRunSchema)) b: In<typeof depreciationRunSchema>) { return this.api.run(org, c, (tx, x) => this.depreciation.post(tx, { ...x, ...b })); }
  @Get('depreciation-runs/:runId') @RequirePermissions('assets:read')
  getRun(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('runId') id: string) { return this.api.run(org, c, (tx) => this.depreciation.get(tx, c, id)); }
  @Post('depreciation-runs/:runId/reverse') @HttpCode(200) @RequirePermissions('assets:manage') @Idempotent()
  reverseRun(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('runId') id: string, @Body(new ZodPipe(reverseAssetEventSchema)) b: In<typeof reverseAssetEventSchema>) {
    return this.api.run(org, c, (tx, x) => this.depreciation.reverse(tx, { ...x, id, ...b }));
  }
}
