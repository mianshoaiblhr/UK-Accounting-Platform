import { Body, Controller, Get, HttpCode, Inject, Injectable, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import type { z } from 'zod';
import {
  approveSalesDocumentSchema, attachSalesDocumentSchema, createCreditNoteSchema, createInvoiceSchema, discardSalesDocumentSchema, salesDocumentListQuerySchema, salesSettingsSchema, updateSalesDraftSchema,
  type Permission,
} from '@uk/contracts';
import { notFound } from '@uk/core';
import type { Database, Tx } from '@uk/db';
import type { AiProposalService } from '@uk/platform';
import { SalesService, type SalesActor } from '@uk/accounting';
import { Idempotent, Org, RequireFeature, RequirePermissions } from '../common/decorators';
import { AI_PROPOSALS, DB } from '../common/tokens';
import type { OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { EvidenceService } from '../evidence/evidence.service';

const ID = (n: string) => Param(n, ParseUUIDPipe);

@Injectable()
export class SalesApiService {
  constructor(@Inject(DB) private readonly db: Database, @Inject(AI_PROPOSALS) private readonly proposals: AiProposalService, private readonly sales: SalesService, private readonly evidence: EvidenceService) {}
  actor(org: OrgAccess): SalesActor { return { kind: 'USER', userId: org.userId, can: (p, companyId) => org.access.can(p as Permission, { companyId }) }; }
  run<T>(org: OrgAccess, fn: (tx: Tx, a: SalesActor) => Promise<T>) { return this.db.tenant({ organisationId: org.organisationId, userId: org.userId }, (tx) => fn(tx, this.actor(org))); }

  /** A draft from an ACCEPTED AI proposal records the application on the proposal in the same transaction (a person applies it; AI never approves). */
  createInvoice(org: OrgAccess, companyId: string, b: z.output<typeof createInvoiceSchema>) {
    return this.run(org, async (tx, actor) => {
      const doc = await this.sales.createInvoice(tx, { organisationId: org.organisationId, companyId, actor, ...b });
      if (b.aiProposalId) await this.proposals.recordApplication(tx, { proposalId: b.aiProposalId, appliedByUserId: org.userId, reference: `sales_document:${doc.id}` });
      return doc;
    });
  }

  async attach(org: OrgAccess, companyId: string, id: string, b: z.output<typeof attachSalesDocumentSchema>) {
    await this.run(org, (tx) => this.sales.get(tx, companyId, id));
    return this.evidence.create(org, { sourceType: 'document', sourceId: b.documentId, targetType: 'sales_document', targetId: id, kind: 'ATTACHED_TO', note: b.note });
  }
  async attachments(org: OrgAccess, companyId: string, id: string) {
    const exists = await this.run(org, (tx) => tx.salesDocument.findFirst({ where: { id, companyId }, select: { id: true } }));
    if (!exists) throw notFound('Sales document not found');
    return this.evidence.list(org, { entityType: 'sales_document', entityId: id, direction: 'in', limit: 100 });
  }
}

/** Sales documents (M5a): invoices and credit notes - drafts, approval (numbered, posted, immutable), credit-note allocation, receivables reconciliation. */
@Controller('organisations/:organisationId/companies/:companyId')
@RequireFeature('bookkeeping.core')
export class SalesController {
  constructor(private readonly api: SalesApiService, private readonly sales: SalesService) {}

  @Get('sales-settings') @RequirePermissions('sales:read')
  settings(@Org() org: OrgAccess, @ID('companyId') c: string) { return this.api.run(org, (tx) => this.sales.getSettings(tx, c)); }
  @Put('sales-settings') @RequirePermissions('ledger:policy')
  setSettings(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(salesSettingsSchema)) b: z.output<typeof salesSettingsSchema>) {
    return this.api.run(org, (tx, actor) => this.sales.setSettings(tx, { organisationId: org.organisationId, companyId: c, actor, ...b }));
  }

  @Post('sales/invoices') @RequirePermissions('sales:manage') @Idempotent()
  createInvoice(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(createInvoiceSchema)) b: z.output<typeof createInvoiceSchema>) { return this.api.createInvoice(org, c, b); }
  @Get('sales/invoices') @RequirePermissions('sales:read')
  invoices(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(salesDocumentListQuerySchema)) q: z.output<typeof salesDocumentListQuerySchema>) {
    return this.api.run(org, (tx) => this.sales.list(tx, c, { ...q, kind: 'INVOICE' }));
  }
  @Post('sales/credit-notes') @RequirePermissions('sales:manage') @Idempotent()
  createCreditNote(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(createCreditNoteSchema)) b: z.output<typeof createCreditNoteSchema>) {
    return this.api.run(org, (tx, actor) => this.sales.createCreditNote(tx, { organisationId: org.organisationId, companyId: c, actor, ...b }));
  }
  @Get('sales/credit-notes') @RequirePermissions('sales:read')
  creditNotes(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(salesDocumentListQuerySchema)) q: z.output<typeof salesDocumentListQuerySchema>) {
    return this.api.run(org, (tx) => this.sales.list(tx, c, { ...q, kind: 'CREDIT_NOTE' }));
  }
  @Get('sales/documents') @RequirePermissions('sales:read')
  documents(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(salesDocumentListQuerySchema)) q: z.output<typeof salesDocumentListQuerySchema>) {
    return this.api.run(org, (tx) => this.sales.list(tx, c, q));
  }
  @Get('sales/documents/:documentId') @RequirePermissions('sales:read')
  get(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('documentId') id: string) { return this.api.run(org, (tx) => this.sales.get(tx, c, id)); }
  @Patch('sales/documents/:documentId') @RequirePermissions('sales:manage')
  update(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('documentId') id: string, @Body(new ZodPipe(updateSalesDraftSchema)) b: z.output<typeof updateSalesDraftSchema>) {
    return this.api.run(org, (tx, actor) => this.sales.updateDraft(tx, { organisationId: org.organisationId, companyId: c, actor, id, ...b }));
  }
  @Post('sales/documents/:documentId/approve') @HttpCode(200) @RequirePermissions('sales:approve') @Idempotent()
  approve(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('documentId') id: string, @Body(new ZodPipe(approveSalesDocumentSchema)) b: z.output<typeof approveSalesDocumentSchema>) {
    return this.api.run(org, (tx, actor) => this.sales.approve(tx, { organisationId: org.organisationId, companyId: c, actor, id, ...b }));
  }
  @Post('sales/documents/:documentId/discard') @HttpCode(200) @RequirePermissions('sales:manage')
  discard(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('documentId') id: string, @Body(new ZodPipe(discardSalesDocumentSchema)) b: z.output<typeof discardSalesDocumentSchema>) {
    return this.api.run(org, (tx, actor) => this.sales.discard(tx, { organisationId: org.organisationId, companyId: c, actor, id, reason: b.reason }));
  }
  @Get('sales/documents/:documentId/attachments') @RequirePermissions('sales:read')
  attachments(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('documentId') id: string) { return this.api.attachments(org, c, id); }
  @Post('sales/documents/:documentId/attachments') @RequirePermissions('sales:manage') @Idempotent()
  attach(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('documentId') id: string, @Body(new ZodPipe(attachSalesDocumentSchema)) b: z.output<typeof attachSalesDocumentSchema>) { return this.api.attach(org, c, id, b); }
  @Get('sales/reconciliation') @RequirePermissions('sales:read')
  reconciliation(@Org() org: OrgAccess, @ID('companyId') c: string) { return this.api.run(org, (tx) => this.sales.reconciliation(tx, c)); }
}
