import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { FieldEncryption, type AppConfig } from '@uk/core';
import { BankStatementService } from '@uk/platform';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { AuthGuard } from './common/auth.guard';
import { IdempotencyInterceptor } from './common/idempotency.interceptor';
import { InfraModule } from './common/infra.module';
import { FeatureGuard } from './common/feature.guard';
import { OrgGuard } from './common/org.guard';
import { MasterDataController } from './master-data/master-data.controller';
import { MasterDataService } from './master-data/master-data.service';
import { ContactRolesController } from './master-data/contact-roles.controller';
import { ContactRolesService } from './master-data/contact-roles.service';
import { createCompaniesHouse, createHmrcVat } from '@uk/adapters';
import { VatApiService, VatController } from './ledger/vat.controller';
import { VatFilingController, VatReturnController } from './ledger/vat-return.controller';
import { CorporationTaxController } from './tax/corporation-tax.controller';
import { ChFilingController, IxbrlApiService, IxbrlDocumentController, TaxonomyController } from './ixbrl/ixbrl.controller';
import { CompanyComplianceController, ComplianceApiService, ComplianceController } from './compliance/compliance.controller';
import { SalesApiService, SalesController } from './sales/sales.controller';
import { PurchasesApiService, PurchasesController } from './purchases/purchases.controller';
import { CashApiService, CashController } from './cash/cash.controller';
import { BankApiService, BankController } from './bank/bank.controller';
import { ReportsController } from './reports/reports.controller';
import { AccountsApiService, StandardsController } from './accounts/standards.controller';
import { AssetsApiService, FixedAssetsController } from './accounts/fixed-assets.controller';
import { YearEndApiService, YearEndCloseController, YearEndController } from './accounts/year-end.controller';
import { DirectorsController } from './accounts/directors.controller';
import { AccountsDocumentController } from './accounts/accounts-document.controller';
import { SizeTestController } from './accounts/size-test.controller';
import { ReviewController } from './accounts/review.controller';
import { YearEndWorkflowController } from './accounts/year-end-workflow.controller';
import { AccountsApprovalController } from './accounts/accounts-approval.controller';
import { ReferenceController } from './master-data/reference.controller';
import { FeatureFlagsController } from './features/features.controller';
import { ProblemFilter } from './common/problem.filter';
import { CompaniesController } from './companies/companies.controller';
import { CompaniesService } from './companies/companies.service';
import { DocumentsController } from './documents/documents.controller';
import { DocumentsService } from './documents/documents.service';
import { EvidenceController } from './evidence/evidence.controller';
import { EvidenceService } from './evidence/evidence.service';
import { FoldersController } from './documents/folders.controller';
import { FoldersService } from './documents/folders.service';
import { AiController } from './ai/ai.controller';
import { IntegrationsController } from './integrations/integrations.controller';
import { NotificationsController } from './notifications/notifications.controller';
import { TasksController } from './tasks/tasks.controller';
import { TasksService } from './tasks/tasks.service';
import { WorkflowsController } from './workflows/workflows.controller';
import { HealthController } from './health/health.controller';
import { JobsController } from './jobs/jobs.controller';
import { PracticesController } from './practices/practices.controller';
import { PracticesService } from './practices/practices.service';
import { OrganisationsController } from './organisations/organisations.controller';
import { OrganisationsService } from './organisations/organisations.service';
import { LedgerController } from './ledger/ledger.controller';
import { LedgerApiService } from './ledger/ledger.service';
import { CapitalAllowanceService, CorporationTaxService, ChFilingService, IxbrlDocumentService, TaxonomyService, VatFilingService, VatReturnService, ComplianceService, AccountsApprovalService, AccountsDocumentService, CashFlowService, ReviewService, YearEndWorkflowService, SizeTestService, SizeThresholdService, DirectorService, YearEndCloseService, YearEndService, DepreciationService, FixedAssetService, FrameworkService, StandardsService, StatutoryReportService, AlertService, DrillDownService, ReportService, BankService, CashService, ReconciliationService, PurchasesService, SalesService, VatService, AccountService, FxSettingsService, JournalRequestService, LedgerPolicyService, LedgerQueries, PeriodService, PostingService, RateService, RevaluationService } from '@uk/accounting';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [InfraModule.forRoot(config), AuditModule, AuthModule],
      controllers: [HealthController, OrganisationsController, CompaniesController, DocumentsController, FoldersController, EvidenceController, JobsController,
        TasksController, PracticesController, FeatureFlagsController, MasterDataController, ReferenceController, WorkflowsController, NotificationsController, IntegrationsController, AiController, LedgerController, ContactRolesController, VatController, SalesController, PurchasesController, CashController, BankController, ReportsController, StandardsController, FixedAssetsController, YearEndController, YearEndCloseController, DirectorsController, AccountsDocumentController, SizeTestController, ReviewController, YearEndWorkflowController, AccountsApprovalController, ComplianceController, CompanyComplianceController, VatReturnController, VatFilingController, TaxonomyController, IxbrlDocumentController, ChFilingController, CorporationTaxController],
      providers: [
        { provide: PostingService, useFactory: () => new PostingService({ captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        { provide: AccountService, useFactory: () => new AccountService({ captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        { provide: VatService, useFactory: () => new VatService({ captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        { provide: VatReturnService, inject: [VatService], useFactory: (v: VatService) => new VatReturnService(v, { captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        { provide: CorporationTaxService, useFactory: () => new CorporationTaxService({ captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        { provide: CapitalAllowanceService, inject: [CorporationTaxService], useFactory: (ct: CorporationTaxService) => new CapitalAllowanceService(ct, { captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        { provide: TaxonomyService, useFactory: () => new TaxonomyService({ captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) }, IxbrlApiService,
        { provide: ChFilingService, useFactory: () => new ChFilingService(createCompaniesHouse(config), { captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        { provide: IxbrlDocumentService, useFactory: () => new IxbrlDocumentService({ captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        { provide: VatFilingService, inject: [VatService, PostingService], useFactory: (v: VatService, p: PostingService) => new VatFilingService(v, p, createHmrcVat(config), { captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        { provide: ComplianceService, useFactory: () => new ComplianceService({ captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        { provide: SalesService, useFactory: () => new SalesService({ captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        { provide: PurchasesService, useFactory: () => new PurchasesService({ captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        { provide: CashService, useFactory: () => new CashService({ captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        { provide: BankService, useFactory: () => new BankService({ crypto: new FieldEncryption(config.FIELD_ENCRYPTION_KEY), captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        { provide: StandardsService, useFactory: () => new StandardsService({ captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        { provide: FrameworkService, useFactory: () => new FrameworkService({ captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        { provide: StatutoryReportService, useFactory: () => new StatutoryReportService() }, { provide: CashFlowService, useFactory: () => new CashFlowService() }, AccountsApiService,
        { provide: FixedAssetService, inject: [PostingService], useFactory: (posting: PostingService) => new FixedAssetService(posting, { captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        { provide: YearEndService, inject: [PostingService], useFactory: (posting: PostingService) => new YearEndService(posting, { captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) }, YearEndApiService,
        { provide: AccountsDocumentService, inject: [StatutoryReportService, DirectorService, YearEndService], useFactory: (st: StatutoryReportService, d: DirectorService, ye: YearEndService) => new AccountsDocumentService(st, d, ye, { captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        { provide: ReviewService, inject: [StatutoryReportService, SalesService, PurchasesService, DirectorService], useFactory: (st: StatutoryReportService, sa: SalesService, pu: PurchasesService, d: DirectorService) =>
          new ReviewService(st, sa, pu, d, { captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        { provide: YearEndWorkflowService, inject: [ReviewService, FixedAssetService, YearEndService, VatService, AccountsDocumentService, SizeTestService],
          useFactory: (r: ReviewService, fa: FixedAssetService, ye: YearEndService, v: VatService, d: AccountsDocumentService, sz: SizeTestService) =>
            new YearEndWorkflowService(r, fa, ye, v, d, sz, { captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        { provide: AccountsApprovalService, inject: [YearEndWorkflowService, PeriodService, FrameworkService], useFactory: (w: YearEndWorkflowService, p: PeriodService, f: FrameworkService) =>
          new AccountsApprovalService(w, p, f, { captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        { provide: SizeThresholdService, useFactory: () => new SizeThresholdService({ captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        { provide: SizeTestService, inject: [StatutoryReportService], useFactory: (st: StatutoryReportService) => new SizeTestService(st) },
        { provide: DirectorService, useFactory: () => new DirectorService({ captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        { provide: YearEndCloseService, inject: [PostingService], useFactory: (posting: PostingService) => new YearEndCloseService(posting, { captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        { provide: DepreciationService, inject: [PostingService], useFactory: (posting: PostingService) => new DepreciationService(posting, { captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) }, AssetsApiService,
        { provide: ReportService, useFactory: () => new ReportService() }, { provide: DrillDownService, useFactory: () => new DrillDownService() }, { provide: AlertService, useFactory: () => new AlertService() },
        { provide: ReconciliationService, useFactory: () => new ReconciliationService({ captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        { provide: BankStatementService, useFactory: () => new BankStatementService({ captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        { provide: RateService, useFactory: () => new RateService({ captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        { provide: FxSettingsService, useFactory: () => new FxSettingsService({ captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        { provide: RevaluationService, inject: [RateService, PostingService], useFactory: (rates: RateService, posting: PostingService) => new RevaluationService(rates, posting, { captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        { provide: PeriodService, inject: [RevaluationService], useFactory: (fx: RevaluationService) => new PeriodService({ captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA, fx }) },
        { provide: LedgerQueries, useFactory: () => new LedgerQueries() },
        { provide: LedgerPolicyService, useFactory: () => new LedgerPolicyService({ captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        { provide: JournalRequestService, inject: [PostingService, LedgerPolicyService], useFactory: (posting: PostingService, policies: LedgerPolicyService) => new JournalRequestService(posting, policies, { captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        LedgerApiService,
        OrganisationsService, PracticesService, MasterDataService, ContactRolesService, VatApiService, ComplianceApiService, SalesApiService, PurchasesApiService, CashApiService, BankApiService, CompaniesService, DocumentsService, FoldersService, EvidenceService, TasksService,
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: OrgGuard },
        { provide: APP_GUARD, useClass: FeatureGuard },
        { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
        { provide: APP_FILTER, useClass: ProblemFilter },
      ],
    };
  }
}
