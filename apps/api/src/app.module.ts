import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import type { AppConfig } from '@uk/core';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { AuthGuard } from './common/auth.guard';
import { IdempotencyInterceptor } from './common/idempotency.interceptor';
import { InfraModule } from './common/infra.module';
import { OrgGuard } from './common/org.guard';
import { ProblemFilter } from './common/problem.filter';
import { CompaniesController } from './companies/companies.controller';
import { CompaniesService } from './companies/companies.service';
import { DocumentsController } from './documents/documents.controller';
import { DocumentsService } from './documents/documents.service';
import { HealthController } from './health/health.controller';
import { JobsController } from './jobs/jobs.controller';
import { OrganisationsController } from './organisations/organisations.controller';
import { OrganisationsService } from './organisations/organisations.service';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [InfraModule.forRoot(config), AuditModule, AuthModule],
      controllers: [HealthController, OrganisationsController, CompaniesController, DocumentsController, JobsController],
      providers: [
        OrganisationsService, CompaniesService, DocumentsService,
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: OrgGuard },
        { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
        { provide: APP_FILTER, useClass: ProblemFilter },
      ],
    };
  }
}
