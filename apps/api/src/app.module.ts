import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import type { AppConfig } from '@uk/core';
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
import { VatApiService, VatController } from './ledger/vat.controller';
import { SalesApiService, SalesController } from './sales/sales.controller';
import { PurchasesApiService, PurchasesController } from './purchases/purchases.controller';
import { CashApiService, CashController } from './cash/cash.controller';
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
import { CashService, PurchasesService, SalesService, VatService, AccountService, FxSettingsService, JournalRequestService, LedgerPolicyService, LedgerQueries, PeriodService, PostingService, RateService, RevaluationService } from '@uk/accounting';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [InfraModule.forRoot(config), AuditModule, AuthModule],
      controllers: [HealthController, OrganisationsController, CompaniesController, DocumentsController, FoldersController, EvidenceController, JobsController,
        TasksController, PracticesController, FeatureFlagsController, MasterDataController, ReferenceController, WorkflowsController, NotificationsController, IntegrationsController, AiController, LedgerController, ContactRolesController, VatController, SalesController, PurchasesController, CashController],
      providers: [
        { provide: PostingService, useFactory: () => new PostingService({ captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        { provide: AccountService, useFactory: () => new AccountService({ captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        { provide: VatService, useFactory: () => new VatService({ captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        { provide: SalesService, useFactory: () => new SalesService({ captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        { provide: PurchasesService, useFactory: () => new PurchasesService({ captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        { provide: CashService, useFactory: () => new CashService({ captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        { provide: RateService, useFactory: () => new RateService({ captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        { provide: FxSettingsService, useFactory: () => new FxSettingsService({ captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        { provide: RevaluationService, inject: [RateService, PostingService], useFactory: (rates: RateService, posting: PostingService) => new RevaluationService(rates, posting, { captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        { provide: PeriodService, inject: [RevaluationService], useFactory: (fx: RevaluationService) => new PeriodService({ captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA, fx }) },
        { provide: LedgerQueries, useFactory: () => new LedgerQueries() },
        { provide: LedgerPolicyService, useFactory: () => new LedgerPolicyService({ captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        { provide: JournalRequestService, inject: [PostingService, LedgerPolicyService], useFactory: (posting: PostingService, policies: LedgerPolicyService) => new JournalRequestService(posting, policies, { captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
        LedgerApiService,
        OrganisationsService, PracticesService, MasterDataService, ContactRolesService, VatApiService, SalesApiService, PurchasesApiService, CashApiService, CompaniesService, DocumentsService, FoldersService, EvidenceService, TasksService,
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: OrgGuard },
        { provide: APP_GUARD, useClass: FeatureGuard },
        { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
        { provide: APP_FILTER, useClass: ProblemFilter },
      ],
    };
  }
}
