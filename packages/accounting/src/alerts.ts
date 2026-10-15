import type { Tx } from '@uk/db';
import { ZERO, fmt, money } from './money';

/**
 * One alert list per company (M8; DEC-044; V1-CTL-03/04/05, V1-BANK-05): what needs a person's attention as at a date, each alert with a severity,
 * a count, the oldest item and drill links. Read-only. Each alert is shown only to a reader who may see its module.
 */
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const daysBefore = (s: string, n: number) => isoDay(new Date(new Date(`${s}T00:00:00.000Z`).getTime() - n * 86_400_000));
const MAX_ITEMS = 20;
type Can = (permission: string) => boolean | Promise<boolean>;
export type AlertSeverity = 'HIGH' | 'MEDIUM' | 'LOW';
export interface Alert { code: string; severity: AlertSeverity; title: string; count: number; total?: string; oldestDate?: string | null; items: Record<string, unknown>[] }

export class AlertService {
  async list(tx: Tx, companyId: string, can: Can, q: { asOf?: string; draftDays?: number; unmatchedDays?: number }) {
    const asOf = q.asOf ?? isoDay(new Date());
    const draftDays = q.draftDays ?? 14, unmatchedDays = q.unmatchedDays ?? 30;
    const company = await tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { baseCurrency: true } });
    const minor = (await tx.currency.findUnique({ where: { code: company.baseCurrency } }))?.minorUnits ?? 2;
    const alerts: Alert[] = [];
    const push = (a: Alert) => { if (a.count > 0) alerts.push({ ...a, items: a.items.slice(0, MAX_ITEMS) }); };

    if (await can('ledger:read')) {
      // balances as at the date of the accounts that must not carry one (suspense) or must not be negative (cash) or should not be (bank)
      const bal = await tx.$queryRaw<{ id: string; code: string; name: string; subtype: string; control_kind: string | null; bal: string }[]>`
        SELECT a.id, a.code, a.name, a.subtype, a.control_kind::text AS control_kind, coalesce(sum(l.debit - l.credit), 0)::text AS bal
          FROM account a JOIN journal_line l ON l.account_id = a.id AND l.organisation_id = a.organisation_id JOIN journal j ON j.id = l.journal_id AND j.organisation_id = l.organisation_id
         WHERE a.company_id = ${companyId}::uuid AND j.journal_date <= ${asOf}::date AND (a.control_kind::text = 'SUSPENSE' OR a.subtype IN ('CURRENT_ASSET_CASH', 'CURRENT_ASSET_BANK'))
         GROUP BY a.id, a.code, a.name, a.subtype, a.control_kind ORDER BY a.code`;
      const suspense = bal.filter((b) => b.control_kind === 'SUSPENSE' && !money(b.bal).isZero());
      push({ code: 'suspense_balance', severity: 'HIGH', title: 'Suspense account has a balance: clear it before locking the period', count: suspense.length,
        total: fmt(suspense.reduce((t, b) => t.plus(money(b.bal)), ZERO), minor), items: suspense.map((b) => ({ accountId: b.id, accountCode: b.code, balance: fmt(money(b.bal), minor), drilldown: { accountId: b.id, from: null, to: asOf } })) });
      const cashNeg = bal.filter((b) => b.subtype === 'CURRENT_ASSET_CASH' && money(b.bal).isNegative());
      push({ code: 'negative_cash', severity: 'HIGH', title: 'Cash in hand is below zero: a receipt is missing or an entry is wrong', count: cashNeg.length,
        items: cashNeg.map((b) => ({ accountId: b.id, accountCode: b.code, balance: fmt(money(b.bal), minor), drilldown: { accountId: b.id, from: null, to: asOf } })) });
      const bankNeg = bal.filter((b) => b.subtype === 'CURRENT_ASSET_BANK' && money(b.bal).isNegative());
      push({ code: 'overdrawn_bank', severity: 'MEDIUM', title: 'Bank account overdrawn in the books', count: bankNeg.length,
        items: bankNeg.map((b) => ({ accountId: b.id, accountCode: b.code, balance: fmt(money(b.bal), minor), drilldown: { accountId: b.id, from: null, to: asOf } })) });
      const pending = await tx.journalRequest.findMany({ where: { companyId, status: 'PENDING' }, orderBy: { requestedAt: 'asc' }, take: MAX_ITEMS + 1, select: { id: true, kind: true, journalDate: true, requestedAt: true } });
      push({ code: 'pending_journal_requests', severity: 'MEDIUM', title: 'Opening balances or control adjustments waiting for approval', count: await tx.journalRequest.count({ where: { companyId, status: 'PENDING' } }),
        oldestDate: pending[0] ? isoDay(pending[0].requestedAt) : null, items: pending.map((r) => ({ requestId: r.id, kind: r.kind, journalDate: isoDay(r.journalDate), requestedAt: r.requestedAt })) });
      const unverified = await tx.taxRate.findMany({ where: { verificationStatus: 'UNVERIFIED', supersededById: null }, select: { id: true, taxCodeId: true, effectiveFrom: true }, take: MAX_ITEMS + 1 });
      push({ code: 'unverified_vat_rates', severity: 'MEDIUM', title: 'VAT rate versions waiting for verification by the tax reviewer (postings with them are refused)', count: await tx.taxRate.count({ where: { verificationStatus: 'UNVERIFIED', supersededById: null } }),
        items: unverified.map((r) => ({ taxRateId: r.id, taxCodeId: r.taxCodeId, effectiveFrom: isoDay(r.effectiveFrom) })) });
    }

    const cutoff = new Date(`${daysBefore(asOf, draftDays)}T00:00:00.000Z`);
    if (await can('sales:read')) {
      const where = { companyId, status: 'DRAFT', issueDate: { lt: cutoff } };
      const items = await tx.salesDocument.findMany({ where, orderBy: { issueDate: 'asc' }, take: MAX_ITEMS + 1, select: { id: true, kind: true, issueDate: true, grossTotal: true, currency: true } });
      push({ code: 'old_sales_drafts', severity: 'MEDIUM', title: `Sales drafts older than ${draftDays} days, not approved`, count: await tx.salesDocument.count({ where }), oldestDate: items[0] ? isoDay(items[0].issueDate) : null,
        items: items.map((d) => ({ documentId: d.id, kind: d.kind, issueDate: isoDay(d.issueDate), gross: d.grossTotal.toFixed(2), currency: d.currency })) });
    }
    if (await can('purchases:read')) {
      const where = { companyId, status: 'DRAFT', issueDate: { lt: cutoff } };
      const items = await tx.purchaseDocument.findMany({ where, orderBy: { issueDate: 'asc' }, take: MAX_ITEMS + 1, select: { id: true, kind: true, issueDate: true, grossTotal: true, currency: true, supplierReference: true } });
      push({ code: 'old_purchase_drafts', severity: 'MEDIUM', title: `Purchase drafts older than ${draftDays} days, not approved`, count: await tx.purchaseDocument.count({ where }), oldestDate: items[0] ? isoDay(items[0].issueDate) : null,
        items: items.map((d) => ({ documentId: d.id, kind: d.kind, supplierReference: d.supplierReference, issueDate: isoDay(d.issueDate), gross: d.grossTotal.toFixed(2), currency: d.currency })) });
      const since = new Date(`${daysBefore(asOf, 90)}T00:00:00.000Z`);
      const flaggedWhere = { companyId, bankDetailsUnverified: true, status: 'POSTED', paymentDate: { gte: since, lte: new Date(`${asOf}T00:00:00.000Z`) } };
      const flagged = await tx.purchasePayment.findMany({ where: flaggedWhere, orderBy: { paymentDate: 'desc' }, take: MAX_ITEMS + 1, select: { id: true, paymentDate: true, amount: true, currency: true, supplierRoleId: true } });
      push({ code: 'payments_to_unverified_bank_details', severity: 'HIGH', title: 'Payments in the last 90 days made while the supplier\'s bank details were unverified: check them for diversion fraud', count: await tx.purchasePayment.count({ where: flaggedWhere }),
        items: flagged.map((p) => ({ paymentId: p.id, paymentDate: isoDay(p.paymentDate), amount: p.amount.toFixed(2), currency: p.currency, supplierRoleId: p.supplierRoleId })) });
      const unverifiedSuppliers = await tx.supplierProfile.findMany({ where: { companyId, bankDetailsStatus: 'UNVERIFIED' }, select: { roleId: true, bankDetailsChangedAt: true }, take: MAX_ITEMS + 1 });
      push({ code: 'supplier_bank_details_unverified', severity: 'MEDIUM', title: 'Supplier bank details changed and not yet verified by a second person', count: await tx.supplierProfile.count({ where: { companyId, bankDetailsStatus: 'UNVERIFIED' } }),
        items: unverifiedSuppliers.map((s) => ({ supplierRoleId: s.roleId, changedAt: s.bankDetailsChangedAt })) });
    }
    if (await can('bank:read')) {
      const old = await tx.$queryRaw<{ bank_account_id: string; name: string; n: number; oldest: Date | null; total: string | null }[]>`
        SELECT b.id AS bank_account_id, b.name, count(s.id)::int AS n, min(s.transaction_date) AS oldest, sum(s.amount - s.matched_amount)::text AS total
          FROM bank_account b JOIN bank_statement_line s ON s.bank_account_id = b.id AND s.organisation_id = b.organisation_id
         WHERE b.company_id = ${companyId}::uuid AND NOT s.voided AND s.matched_amount <> s.amount AND s.transaction_date < ${daysBefore(asOf, unmatchedDays)}::date
         GROUP BY b.id, b.name ORDER BY b.name`;
      push({ code: 'old_unmatched_bank_lines', severity: 'MEDIUM', title: `Statement lines unmatched for more than ${unmatchedDays} days`, count: old.reduce((t, o) => t + o.n, 0),
        oldestDate: old.map((o) => (o.oldest ? isoDay(o.oldest) : null)).filter(Boolean).sort()[0] ?? null,
        items: old.map((o) => ({ bankAccountId: o.bank_account_id, name: o.name, lines: o.n, oldestDate: o.oldest ? isoDay(o.oldest) : null, unmatched: fmt(money(o.total ?? '0'), minor) })) });
    }
    const order: Record<AlertSeverity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    alerts.sort((a, b) => order[a.severity] - order[b.severity] || a.code.localeCompare(b.code));
    return { companyId, asOf, thresholds: { draftDays, unmatchedDays }, count: alerts.length, high: alerts.filter((a) => a.severity === 'HIGH').length, alerts };
  }
}
