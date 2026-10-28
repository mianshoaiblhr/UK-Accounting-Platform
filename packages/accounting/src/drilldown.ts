import { notFound } from '@uk/core';
import type { Tx } from '@uk/db';
import { fmt } from './money';

/**
 * Universal drill-down (M8; DEC-043; V1-RPT-02, MAN-ACC-06/07, XP-01): from a journal to the transaction that posted it and on to the documents
 * attached to either. There is one resolver per journal source type; a test enumerates the journal sources and fails if one has none. What the
 * reader may not see (by module permission) is named but not opened.
 */
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
type Can = (permission: string) => boolean | Promise<boolean>;
export interface DrillTarget { entityType: string; id: string; permission: string; summary?: Record<string, unknown> }
type Resolver = (tx: Tx, sourceId: string) => Promise<DrillTarget | null>;

const salesDoc: Resolver = async (tx, id) => {
  const d = await tx.salesDocument.findFirst({ where: { id } });
  return d && { entityType: 'sales_document', id: d.id, permission: 'sales:read', summary: { kind: d.kind, documentNumber: d.documentNumber, issueDate: isoDay(d.issueDate), currency: d.currency, gross: d.grossTotal.toFixed(2), status: d.status, customerRoleId: d.customerRoleId } };
};
const salesReceipt: Resolver = async (tx, id) => {
  const r = await tx.salesReceipt.findFirst({ where: { id } });
  return r && { entityType: 'sales_receipt', id: r.id, permission: 'sales:read', summary: { receiptDate: isoDay(r.receiptDate), currency: r.currency, amount: r.amount.toFixed(2), reference: r.reference, status: r.status, customerRoleId: r.customerRoleId } };
};
const salesAllocation: Resolver = async (tx, id) => {
  const a = await tx.salesAllocation.findFirst({ where: { id } });
  return a && { entityType: 'sales_allocation', id: a.id, permission: 'sales:read', summary: { invoiceId: a.invoiceId, creditId: a.creditId, receiptId: a.receiptId, amount: a.amount.toFixed(2), allocatedOn: isoDay(a.allocatedOn) } };
};
const purchaseDoc: Resolver = async (tx, id) => {
  const d = await tx.purchaseDocument.findFirst({ where: { id } });
  return d && { entityType: 'purchase_document', id: d.id, permission: 'purchases:read', summary: { kind: d.kind, documentNumber: d.documentNumber, supplierReference: d.supplierReference, issueDate: isoDay(d.issueDate), currency: d.currency, gross: d.grossTotal.toFixed(2), status: d.status, supplierRoleId: d.supplierRoleId } };
};
const purchasePayment: Resolver = async (tx, id) => {
  const p = await tx.purchasePayment.findFirst({ where: { id } });
  return p && { entityType: 'purchase_payment', id: p.id, permission: 'purchases:read', summary: { paymentDate: isoDay(p.paymentDate), currency: p.currency, amount: p.amount.toFixed(2), reference: p.reference, status: p.status, supplierRoleId: p.supplierRoleId, bankDetailsUnverified: p.bankDetailsUnverified } };
};
const purchaseAllocation: Resolver = async (tx, id) => {
  const a = await tx.purchaseAllocation.findFirst({ where: { id } });
  return a && { entityType: 'purchase_allocation', id: a.id, permission: 'purchases:read', summary: { billId: a.billId, debitId: a.debitId, paymentId: a.paymentId, amount: a.amount.toFixed(2), allocatedOn: isoDay(a.allocatedOn) } };
};
const cash: Resolver = async (tx, id) => {
  const t = await tx.cashTransaction.findFirst({ where: { id } });
  return t && { entityType: 'cash_transaction', id: t.id, permission: 'cash:read', summary: { direction: t.direction, transactionDate: isoDay(t.transactionDate), gross: t.grossTotal.toFixed(2), vat: t.vatTotal.toFixed(2), reference: t.reference, counterparty: t.counterparty, status: t.status } };
};
const transfer: Resolver = async (tx, id) => {
  const t = await tx.bankTransfer.findFirst({ where: { id } });
  return t && { entityType: 'bank_transfer', id: t.id, permission: 'bank:read', summary: { transferDate: isoDay(t.transferDate), currency: t.currency, amount: t.amount.toFixed(2), fromAccountId: t.fromAccountId, toAccountId: t.toAccountId, reference: t.reference, status: t.status } };
};
const request: Resolver = async (tx, id) => {
  const r = await tx.journalRequest.findFirst({ where: { id } });
  return r && { entityType: 'journal_request', id: r.id, permission: 'ledger:read', summary: { kind: r.kind, status: r.status, journalDate: isoDay(r.journalDate), reason: r.reason, requestedByUserId: r.requestedByUserId, evidenceDocumentIds: r.evidenceDocumentIds } };
};
const revaluation: Resolver = async (tx, id) => {
  const r = await tx.fxRevaluationRun.findFirst({ where: { id } });
  return r && { entityType: 'fx_revaluation_run', id: r.id, permission: 'ledger:read', summary: { asAt: isoDay(r.asAtDate), status: r.status, netAdjustment: r.netAdjustment.toFixed(2), revaluationJournalId: r.revaluationJournalId, reversalJournalId: r.reversalJournalId } };
};
const reversed: Resolver = async (tx, id) => {
  const j = await tx.journal.findFirst({ where: { id } });
  return j && { entityType: 'journal', id: j.id, permission: 'ledger:read', summary: { journalNumber: j.journalNumber, journalDate: isoDay(j.journalDate), sourceType: j.sourceType, description: j.description } };
};
const fixedAsset: Resolver = async (tx, id) => {
  const a = await tx.fixedAsset.findFirst({ where: { id } });
  return a && { entityType: 'fixed_asset', id: a.id, permission: 'assets:read', summary: { number: a.number, description: a.description, acquiredOn: isoDay(a.acquiredOn), cost: a.cost.toFixed(2), status: a.status, additionKind: a.additionKind,
    disposedOn: a.disposedOn ? isoDay(a.disposedOn) : null, gainOrLoss: a.gainOrLoss?.toFixed(2) ?? null } };
};
const depreciationRun: Resolver = async (tx, id) => {
  const r = await tx.depreciationRun.findFirst({ where: { id } });
  return r && { entityType: 'depreciation_run', id: r.id, permission: 'assets:read', summary: { asAt: isoDay(r.asAt), status: r.status, total: r.total.toFixed(2), journalId: r.journalId, reversalJournalId: r.reversalJournalId } };
};
const yearEndItem: Resolver = async (tx, id) => {
  const i = await tx.yearEndItem.findFirst({ where: { id } });
  return i && { entityType: 'year_end_item', id: i.id, permission: 'ledger:read', summary: { kind: i.kind, description: i.description, amount: i.amount.toFixed(2), date: isoDay(i.itemDate), status: i.status, evidenceDocumentIds: i.evidenceDocumentIds } };
};
const releaseRun: Resolver = async (tx, id) => {
  const r = await tx.releaseRun.findFirst({ where: { id } });
  return r && { entityType: 'release_run', id: r.id, permission: 'ledger:read', summary: { asAt: isoDay(r.asAt), status: r.status, total: r.total.toFixed(2), journalId: r.journalId, reversalJournalId: r.reversalJournalId } };
};
const provisionMovement: Resolver = async (tx, id) => {
  const m = await tx.provisionMovement.findFirst({ where: { id } });
  return m && { entityType: 'provision_movement', id: m.id, permission: 'ledger:read', summary: { provisionId: m.provisionId, kind: m.kind, date: isoDay(m.movementDate), amount: m.amount.toFixed(2), reason: m.reason, status: m.status } };
};
const yearEndClose: Resolver = async (tx, id) => {
  const c = await tx.yearEndClose.findFirst({ where: { id } });
  return c && { entityType: 'year_end_close', id: c.id, permission: 'ledger:read', summary: { yearStart: isoDay(c.yearStart), yearEnd: isoDay(c.yearEnd), profit: c.profit.toFixed(2), status: c.status, journalId: c.journalId, reversalJournalId: c.reversalJournalId } };
};
const vatFiling: Resolver = async (tx, id) => {
  const f = await tx.vatFiling.findFirst({ where: { id } });
  return f && { entityType: 'vat_filing', id: f.id, permission: 'ledger:read', summary: { vatReturnId: f.vatReturnId, mode: f.mode, submittedOn: isoDay(f.submittedOn), receiptReference: f.receiptReference, evidenceDocumentId: f.evidenceDocumentId } };
};

/** One resolver per journal source (DEC-043). MANUAL journals have no source transaction: their evidence hangs on the journal itself. */
export const DRILL_RESOLVERS: Record<string, Resolver | null> = {
  MANUAL: null,
  OPENING_BALANCE: request, CONTROL_ADJUSTMENT: request,
  FX_REVALUATION: revaluation, REVERSAL: reversed,
  SALES_INVOICE: salesDoc, SALES_CREDIT_NOTE: salesDoc, SALES_RECEIPT: salesReceipt, SALES_RECEIPT_REVERSAL: salesReceipt, SALES_ALLOCATION_FX: salesAllocation,
  PURCHASE_BILL: purchaseDoc, PURCHASE_DEBIT_NOTE: purchaseDoc, PURCHASE_PAYMENT: purchasePayment, PURCHASE_PAYMENT_REVERSAL: purchasePayment, PURCHASE_ALLOCATION_FX: purchaseAllocation,
  CASH_PAYMENT: cash, CASH_RECEIPT: cash, CASH_PAYMENT_REVERSAL: cash, CASH_RECEIPT_REVERSAL: cash,
  BANK_TRANSFER: transfer, BANK_TRANSFER_REVERSAL: transfer,
  FIXED_ASSET_ADDITION: fixedAsset, FIXED_ASSET_ADDITION_REVERSAL: fixedAsset, FIXED_ASSET_DISPOSAL: fixedAsset, FIXED_ASSET_DISPOSAL_REVERSAL: fixedAsset,
  FIXED_ASSET_DEPRECIATION: depreciationRun, FIXED_ASSET_DEPRECIATION_REVERSAL: depreciationRun,
  ACCRUAL: yearEndItem, ACCRUAL_AUTO_REVERSAL: yearEndItem, ACCRUAL_CANCELLATION: yearEndItem, ADJUSTMENT_SETUP: yearEndItem, ADJUSTMENT_SETUP_REVERSAL: yearEndItem,
  ADJUSTMENT_RELEASE: releaseRun, ADJUSTMENT_RELEASE_REVERSAL: releaseRun, PROVISION_MOVEMENT: provisionMovement, PROVISION_MOVEMENT_REVERSAL: provisionMovement, YEAR_END_CLOSE: yearEndClose, YEAR_END_CLOSE_REVERSAL: yearEndClose,
  VAT_RETURN: vatFiling,
};
/** Evidence-graph entity types that can carry attached documents. */
const EVIDENCE_TYPES = new Set(['sales_document', 'purchase_document', 'cash_transaction', 'journal']);

export class DrillDownService {
  private async attachments(tx: Tx, entityType: string, id: string) {
    if (!EVIDENCE_TYPES.has(entityType)) return [];
    const links = await tx.evidenceLink.findMany({ where: { targetType: entityType, targetId: id, revokedAt: null }, orderBy: { createdAt: 'asc' } });
    // the link names the document; opening it goes through the document service and its visibility rules
    return links.map((l) => ({ linkId: l.id, sourceType: l.sourceType, sourceId: l.sourceId, kind: l.kind, note: l.note, createdAt: l.createdAt }));
  }

  /** Journal -> its lines -> the source transaction -> attached documents; and statement lines the journal is matched to. */
  async journalSource(tx: Tx, companyId: string, journalId: string, can: Can) {
    const j = await tx.journal.findFirst({ where: { id: journalId, companyId } });
    if (!j) throw notFound('Journal not found');
    const minor = (await tx.currency.findUnique({ where: { code: j.currency } }))?.minorUnits ?? 2;
    const lines = await tx.journalLine.findMany({ where: { journalId: j.id }, orderBy: { lineNo: 'asc' } });
    const accounts = new Map((await tx.account.findMany({ where: { id: { in: [...new Set(lines.map((l) => l.accountId))] } }, select: { id: true, code: true, name: true } })).map((a) => [a.id, a]));
    const resolver = DRILL_RESOLVERS[j.sourceType];
    let source: Record<string, unknown> | null = null;
    if (resolver && j.sourceId) {
      const t = await resolver(tx, j.sourceId);
      if (t) {
        source = (await can(t.permission))
          ? { entityType: t.entityType, id: t.id, ...t.summary, attachments: await this.attachments(tx, t.entityType, t.id) }
          : { entityType: t.entityType, id: t.id, restricted: true, requires: t.permission };
      }
    }
    const matches = (await can('bank:read')) ? await tx.bankMatch.findMany({ where: { journalId: j.id, status: 'ACTIVE' }, select: { id: true, statementLineId: true, journalLineId: true, amount: true } }) : [];
    return {
      journal: { id: j.id, journalNumber: j.journalNumber, journalDate: isoDay(j.journalDate), sourceType: j.sourceType, sourceId: j.sourceId, sourceReference: j.sourceReference, description: j.description,
        total: fmt(j.total, minor), postedByUserId: j.postedByUserId, reversesJournalId: j.reversesJournalId },
      lines: lines.map((l) => ({ lineNo: l.lineNo, accountId: l.accountId, accountCode: accounts.get(l.accountId)?.code ?? null, accountName: accounts.get(l.accountId)?.name ?? null,
        debit: fmt(l.debit, minor), credit: fmt(l.credit, minor), description: l.description, drilldown: { accountId: l.accountId, from: isoDay(j.journalDate), to: isoDay(j.journalDate) } })),
      source, sourceResolver: resolver ? 'resolved' : 'none (a manual journal: its evidence is attached to the journal)',
      journalAttachments: await this.attachments(tx, 'journal', j.id),
      bankMatches: matches.map((m) => ({ id: m.id, statementLineId: m.statementLineId, journalLineId: m.journalLineId, amount: m.amount.toFixed(2) })),
    };
  }
}
