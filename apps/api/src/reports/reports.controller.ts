import { Controller, Get, Inject, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import type { z } from 'zod';
import { alertQuerySchema, balanceSheetQuerySchema, fxReportQuerySchema, profitAndLossQuerySchema, type Permission } from '@uk/contracts';
import type { Database, Tx } from '@uk/db';
import { AlertService, DrillDownService, ReportService } from '@uk/accounting';
import { Org, RequireFeature, RequirePermissions } from '../common/decorators';
import { DB } from '../common/tokens';
import type { OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';

const ID = (n: string) => Param(n, ParseUUIDPipe);

/** Reports (M8): statements from the ledger only, the FX report, universal drill-down and the alert list. Read-only. */
@Controller('organisations/:organisationId/companies/:companyId')
@RequireFeature('bookkeeping.core')
export class ReportsController {
  constructor(@Inject(DB) private readonly db: Database, private readonly reports: ReportService, private readonly drill: DrillDownService, private readonly alerts: AlertService) {}
  private run<T>(org: OrgAccess, fn: (tx: Tx) => Promise<T>) { return this.db.tenant({ organisationId: org.organisationId, userId: org.userId }, fn); }
  private can(org: OrgAccess, companyId: string) { return (p: string) => org.access.can(p as Permission, { companyId }); }

  @Get('reports/profit-and-loss') @RequirePermissions('ledger:read')
  profitAndLoss(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(profitAndLossQuerySchema)) q: z.output<typeof profitAndLossQuerySchema>) { return this.run(org, (tx) => this.reports.profitAndLoss(tx, c, q)); }
  @Get('reports/balance-sheet') @RequirePermissions('ledger:read')
  balanceSheet(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(balanceSheetQuerySchema)) q: z.output<typeof balanceSheetQuerySchema>) { return this.run(org, (tx) => this.reports.balanceSheet(tx, c, q)); }
  @Get('reports/fx') @RequirePermissions('ledger:read')
  fx(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(fxReportQuerySchema)) q: z.output<typeof fxReportQuerySchema>) { return this.run(org, (tx) => this.reports.fx(tx, c, q)); }
  @Get('journals/:journalId/source') @RequirePermissions('ledger:read')
  source(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('journalId') id: string) { return this.run(org, (tx) => this.drill.journalSource(tx, c, id, this.can(org, c))); }
  @Get('alerts') @RequirePermissions('ledger:read')
  list(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(alertQuerySchema)) q: z.output<typeof alertQuerySchema>) { return this.run(org, (tx) => this.alerts.list(tx, c, this.can(org, c), q)); }
}
