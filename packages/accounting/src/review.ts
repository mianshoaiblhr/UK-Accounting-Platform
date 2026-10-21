import { CLOSING_SOURCES, REVIEW_CONTROL_CODES, REVIEW_CONTROLS, type ReviewControl } from '@uk/contracts';
import { conflict, forbidden, notFound, unprocessable } from '@uk/core';
import type { Tx } from '@uk/db';
import { auditRow } from '@uk/platform';
import { assertYearOpen } from './accounts-document';
import type { DirectorService } from './directors';
import { ZERO, money, type Money } from './money';
import type { PostingActor } from './posting';
import type { PurchasesService } from './purchases';
import type { SalesService } from './sales';
import type { StatutoryReportService } from './statutory-report';

/**
 * V2-M6a (DEC-068; v2-plan section 5h): review flags and the review checklist. The nine controls are raised live each time from the ledger
 * (closing journals left out), the registers and the documents; the firm's settings are versioned data, never legal values. What is stored is
 * each response to a flag, written once with the flag's figures: explained by a preparer, signed off by another person holding accounts:review,
 * or reopened. A response whose figures no longer match the flag lapses. The database repeats the second-person rule.
 */
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
const f2 = (m: Money) => m.toFixed(2);
type Ctx = { organisationId: string; companyId: string; actor: PostingActor };
type Figures = Record<string, string | number | string[] | null>;
type FlagState = 'OPEN' | 'EXPLAINED' | 'SIGNED_OFF';
interface RaisedFlag { key: string; control: ReviewControl; subject: { type: string; id: string; label: string }; figures: Figures; drilldown?: Record<string, string | null> }
interface Settings { unexplainedAmount: Money | null; materialAmount: Money | null; materialPercent: Money | null; oldItemDays: number | null; evidenceAmount: Money | null }
const MANUAL_SOURCES = ['MANUAL', 'CONTROL_ADJUSTMENT'];
const BEYOND: Record<number, string[]> = { 30: ['days31to60', 'days61to90', 'over90'], 60: ['days61to90', 'over90'], 90: ['over90'] };
/** What a control needs from the settings before it can be evaluated. */
const NEEDS: Partial<Record<ReviewControl, (keyof Settings)[]>> = { 'RC-01': ['unexplainedAmount'], 'RC-02': ['materialAmount', 'materialPercent'], 'RC-05': ['oldItemDays'], 'RC-09': ['evidenceAmount'] };

/** Canonical form of figures (sorted keys), so equality does not depend on key order. */
export const canonicalFigures = (f: unknown): string => JSON.stringify(f, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));

/** The state of a flag from its responses, oldest first (pure). An explanation or sign-off whose figures differ from the flag's lapses. */
export function flagState(responses: { action: string; figures: unknown; byUserId: string }[], current: Figures): { state: FlagState; changed: boolean; explainedBy: string | null } {
  let state: FlagState = 'OPEN', explained: { figures: unknown; by: string } | null = null;
  for (const r of responses) {
    if (r.action === 'EXPLAIN') { state = 'EXPLAINED'; explained = { figures: r.figures, by: r.byUserId }; }
    else if (r.action === 'SIGN_OFF' && state === 'EXPLAINED') state = 'SIGNED_OFF';
    else if (r.action === 'REOPEN') { state = 'OPEN'; explained = null; }
  }
  if (state !== 'OPEN' && explained && canonicalFigures(explained.figures) !== canonicalFigures(current)) return { state: 'OPEN', changed: true, explainedBy: null };
  return { state, changed: false, explainedBy: state === 'OPEN' ? null : explained?.by ?? null };
}

export class ReviewService {
  constructor(private readonly statutory: StatutoryReportService, private readonly sales: SalesService, private readonly purchases: PurchasesService,
    private readonly directors: DirectorService, private readonly opts: { captureDeviceMetadata?: boolean } = {}) {}
  private audit(tx: Tx, e: Parameters<typeof auditRow>[0]) { return tx.auditEvent.createMany({ data: [auditRow(e, this.opts.captureDeviceMetadata)] }); }
  private async need(actor: PostingActor, permission: string, companyId: string) {
    if (actor.kind !== 'USER') throw forbidden('Only a person can respond to review flags or change review settings', 'ai_cannot_write');
    if (!(await actor.can(permission, companyId))) throw forbidden(`Requires permission ${permission}`, 'permission_denied');
  }
  private async framework(tx: Tx, companyId: string, yearStart: string) {
    const fw = await tx.companyReportingFramework.findFirst({ where: { companyId, yearStart: toDate(yearStart) } });
    if (!fw) throw notFound(`No reporting framework is set for the year starting ${yearStart}`, 'framework_not_set');
    return fw;
  }

  // ───── Settings (the firm's, versioned) ─────
  private settingsView(r: Awaited<ReturnType<Tx['reviewSetting']['findFirstOrThrow']>> | null) {
    if (!r) return null;
    const o = (m: Money | null) => (m === null ? null : f2(m));
    return { id: r.id, unexplainedAmount: o(r.unexplainedAmount), materialAmount: o(r.materialAmount), materialPercent: o(r.materialPercent), oldItemDays: r.oldItemDays,
      evidenceAmount: o(r.evidenceAmount), reason: r.reason, setByUserId: r.setByUserId, setAt: r.setAt };
  }
  async settings(tx: Tx, companyId: string) {
    const rows = await tx.reviewSetting.findMany({ where: { companyId }, orderBy: [{ setAt: 'desc' }, { id: 'desc' }] });
    return { current: this.settingsView(rows[0] ?? null), history: rows.map((r) => this.settingsView(r)!),
      notice: 'The firm\'s review settings, not legal values. A control whose setting is not set is not evaluated and is never treated as passed (DEC-068).' };
  }
  async setSettings(tx: Tx, a: Ctx & { unexplainedAmount?: string | null; materialAmount?: string | null; materialPercent?: string | null; oldItemDays?: number | null; evidenceAmount?: string | null; reason: string }) {
    await this.need(a.actor, 'accounts:prepare', a.companyId);
    const m = (v: string | null | undefined) => (v ? money(v) : null);
    const r = await tx.reviewSetting.create({ data: { organisationId: a.organisationId, companyId: a.companyId, unexplainedAmount: m(a.unexplainedAmount), materialAmount: m(a.materialAmount),
      materialPercent: m(a.materialPercent), oldItemDays: a.oldItemDays ?? null, evidenceAmount: m(a.evidenceAmount), reason: a.reason, setByUserId: a.actor.userId! } });
    await this.audit(tx, { action: 'accounts.review_settings_set', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'review_setting', entityId: r.id,
      after: this.settingsView(r)!, reason: a.reason });
    return this.settings(tx, a.companyId);
  }
  private async currentSettings(tx: Tx, companyId: string): Promise<Settings> {
    const r = await tx.reviewSetting.findFirst({ where: { companyId }, orderBy: [{ setAt: 'desc' }, { id: 'desc' }] });
    return { unexplainedAmount: r?.unexplainedAmount ?? null, materialAmount: r?.materialAmount ?? null, materialPercent: r?.materialPercent ?? null, oldItemDays: r?.oldItemDays ?? null, evidenceAmount: r?.evidenceAmount ?? null };
  }

  // ───── The flags of a year ─────
  private async raise(tx: Tx, companyId: string, fw: { yearStart: Date; yearEnd: Date }, s: Settings) {
    const start = isoDay(fw.yearStart), end = isoDay(fw.yearEnd);
    const flags: RaisedFlag[] = [];
    const add = (control: ReviewControl, type: string, id: string, label: string, figures: Figures, drilldown?: Record<string, string | null>) =>
      flags.push({ key: `${control}:${type}:${id}`, control, subject: { type, id, label }, figures, ...(drilldown ? { drilldown } : {}) });
    const evaluated = new Set(REVIEW_CONTROL_CODES.filter((c) => (NEEDS[c] ?? []).every((k) => s[k] !== null)));

    // RC-01: manual and control-adjustment journals of the year at or above the setting
    const manual = await tx.journal.findMany({ where: { companyId, sourceType: { in: MANUAL_SOURCES }, journalDate: { gte: fw.yearStart, lte: fw.yearEnd } }, orderBy: [{ journalDate: 'asc' }, { journalNumber: 'asc' }],
      select: { id: true, journalNumber: true, journalDate: true, sourceType: true, description: true, total: true } });
    if (evaluated.has('RC-01')) for (const j of manual) if (j.total.greaterThanOrEqualTo(s.unexplainedAmount!))
      add('RC-01', 'journal', j.id, `Journal ${j.journalNumber}: ${j.description}`, { date: isoDay(j.journalDate), source: j.sourceType, amount: f2(j.total) }, { journalId: j.id });

    // RC-02: statutory lines with accounts and the retained profit, against the comparative
    if (evaluated.has('RC-02')) {
      const pv = await this.statutory.preview(tx, companyId, { yearStart: start, compare: true });
      for (const l of [...pv.statements.profitAndLoss, ...pv.statements.balanceSheet]) {
        if (l.kind !== 'ACCOUNTS' && l.kind !== 'RETAINED_PROFIT') continue;
        if (l.amount === null || l.comparative === null || l.comparative === undefined) continue;
        const cur = money(l.amount), prior = money(l.comparative), change = cur.minus(prior);
        if (change.abs().lessThan(s.materialAmount!)) continue;
        const pct = prior.isZero() ? null : change.abs().div(prior.abs()).times(100);
        if (pct !== null && pct.lessThan(s.materialPercent!)) continue;
        add('RC-02', 'line', l.key, l.name, { line: l.key, current: f2(cur), comparative: f2(prior), change: f2(change), percent: pct === null ? null : f2(pct) });
      }
    }

    // RC-03, RC-04, RC-07, RC-08: balances by account
    const skip = [...CLOSING_SOURCES];
    const rows = await tx.$queryRaw<{ id: string; code: string; name: string; type: string; subtype: string; control_kind: string | null; year: string; cumulative: string }[]>`
      SELECT a.id, a.code, a.name, a.type::text AS type, a.subtype, a.control_kind::text AS control_kind,
             coalesce(sum(CASE WHEN j.journal_date >= ${start}::date AND j.source_type <> ALL(${skip}::text[]) THEN l.debit - l.credit ELSE 0 END), 0)::text AS year,
             coalesce(sum(l.debit - l.credit), 0)::text AS cumulative
        FROM account a JOIN journal_line l ON l.account_id = a.id AND l.organisation_id = a.organisation_id
        JOIN journal j ON j.id = l.journal_id AND j.organisation_id = l.organisation_id
       WHERE a.company_id = ${companyId}::uuid AND j.journal_date <= ${end}::date
       GROUP BY 1, 2, 3, 4, 5, 6 ORDER BY a.code COLLATE "C"`;
    const bankAccounts = await tx.bankAccount.findMany({ where: { companyId }, select: { id: true, accountId: true, name: true, status: true, closedAt: true, statementOpeningDate: true } });
    for (const r of rows) {
      const year = money(r.year), cum = money(r.cumulative);
      const natural = (v: Money) => (r.type === 'ASSET' || r.type === 'EXPENSE' ? v : v.negated());
      const drill = { accountId: r.id, from: r.type === 'INCOME' || r.type === 'EXPENSE' ? start : null, to: end };
      if ((r.type === 'INCOME' || r.type === 'EXPENSE') && natural(year).isNegative()) add('RC-03', 'account', r.id, `${r.code} ${r.name}`, { account: r.code, balance: f2(natural(year)) }, drill);
      if (((r.type === 'ASSET' && r.subtype !== 'FIXED_ASSET_DEPRECIATION') || r.type === 'LIABILITY') && natural(cum).isNegative())
        add('RC-04', 'account', r.id, `${r.code} ${r.name}`, { account: r.code, balance: f2(natural(cum)) }, drill);
      if (r.control_kind === 'SUSPENSE' && !cum.isZero()) add('RC-07', 'account', r.id, `${r.code} ${r.name}`, { account: r.code, balance: f2(cum) }, drill);
      if (r.subtype === 'CURRENT_ASSET_BANK' && !cum.isZero() && !bankAccounts.some((b) => b.accountId === r.id))
        add('RC-08', 'account', r.id, `${r.code} ${r.name}`, { account: r.code, reason: 'NO_BANK_ACCOUNT', ledgerBalance: f2(cum) }, drill);
    }
    // RC-08: every bank account in use at the year end needs a signed reconciliation at the year end without a difference
    for (const b of bankAccounts) {
      if (b.statementOpeningDate > fw.yearEnd || (b.status === 'CLOSED' && b.closedAt && b.closedAt < fw.yearEnd)) continue;
      const rec = await tx.bankReconciliation.findFirst({ where: { bankAccountId: b.id, asAt: fw.yearEnd }, orderBy: { signedAt: 'desc' } });
      const code = rows.find((r) => r.id === b.accountId)?.code ?? '';
      const ledger = money(rows.find((r) => r.id === b.accountId)?.cumulative ?? '0');
      if (!rec) add('RC-08', 'bank', b.id, `${b.name}${code ? ` (${code})` : ''}`, { account: code, reason: 'NOT_RECONCILED', ledgerBalance: f2(ledger) });
      else if (!rec.difference.isZero()) add('RC-08', 'bank', b.id, `${b.name}${code ? ` (${code})` : ''}`, { account: code, reason: 'DIFFERENCE', ledgerBalance: f2(ledger), difference: f2(rec.difference) });
    }

    // RC-05: amounts overdue beyond the setting at the year end, from the V1 aged reports
    if (evaluated.has('RC-05')) {
      const beyond = BEYOND[s.oldItemDays!] ?? [];
      const over = (row: Record<string, unknown>) => beyond.reduce((t, k) => t.plus(String(row[k] ?? '0')), ZERO);
      const recv = await this.sales.agedReceivables(tx, companyId, { asOf: end });
      for (const c of recv.customers as Record<string, unknown>[]) { const o = over(c); if (o.greaterThan(0)) add('RC-05', 'customer', `${c.customerRoleId}:${c.currency}`, String(c.name ?? c.accountCode ?? ''), { party: 'CUSTOMER', currency: String(c.currency), overdue: f2(o), beyondDays: s.oldItemDays }); }
      const pay = await this.purchases.agedPayables(tx, companyId, { asOf: end });
      for (const c of pay.suppliers as Record<string, unknown>[]) { const o = over(c); if (o.greaterThan(0)) add('RC-05', 'supplier', `${c.supplierRoleId}:${c.currency}`, String(c.name ?? c.accountCode ?? ''), { party: 'SUPPLIER', currency: String(c.currency), overdue: f2(o), beyondDays: s.oldItemDays }); }
    }

    // RC-06: loan accounts carrying any V2-M4 flag for the year
    const loans = await this.directors.loanReport(tx, companyId, { from: start, to: end });
    for (const l of loans.items) if (l.flags.length)
      add('RC-06', 'loan', l.id, `${l.contactName ?? ''} (${l.accountCode ?? ''})`, { closing: l.closing, lowest: l.lowest, daysOverdrawn: l.daysOverdrawn, flags: [...l.flags] }, { accountId: l.accountId, from: start, to: end });

    // RC-09: manual journals, approved purchase bills and cash payments of the year at or above the setting without live evidence
    if (evaluated.has('RC-09')) {
      const min = s.evidenceAmount!;
      const cands: { type: string; id: string; label: string; date: Date; amount: Money }[] = [
        ...manual.filter((j) => j.total.greaterThanOrEqualTo(min)).map((j) => ({ type: 'journal', id: j.id, label: `Journal ${j.journalNumber}: ${j.description}`, date: j.journalDate, amount: j.total })),
        ...(await tx.purchaseDocument.findMany({ where: { companyId, kind: 'BILL', status: 'APPROVED', issueDate: { gte: fw.yearStart, lte: fw.yearEnd }, grossTotal: { gte: min } },
          select: { id: true, documentNumber: true, supplierReference: true, issueDate: true, grossTotal: true } }))
          .map((d) => ({ type: 'purchase_document', id: d.id, label: `Bill ${d.documentNumber ?? ''}${d.supplierReference ? ` (${d.supplierReference})` : ''}`, date: d.issueDate, amount: d.grossTotal })),
        ...(await tx.cashTransaction.findMany({ where: { companyId, direction: 'PAYMENT', transactionDate: { gte: fw.yearStart, lte: fw.yearEnd }, grossTotal: { gte: min } },
          select: { id: true, description: true, transactionDate: true, grossTotal: true } }))
          .map((c) => ({ type: 'cash_transaction', id: c.id, label: `Cash payment: ${c.description}`, date: c.transactionDate, amount: c.grossTotal })),
      ];
      const ids = cands.map((c) => c.id);
      const links = ids.length ? await tx.evidenceLink.findMany({ where: { revokedAt: null, OR: [
        { sourceId: { in: ids }, targetType: { in: ['document', 'document_version'] } }, { targetId: { in: ids }, sourceType: { in: ['document', 'document_version'] } }] },
        select: { sourceType: true, sourceId: true, targetType: true, targetId: true } }) : [];
      const evidenced = new Set(links.flatMap((l) => [`${l.sourceType}:${l.sourceId}`, `${l.targetType}:${l.targetId}`]));
      cands.sort((x, y) => x.date.getTime() - y.date.getTime() || x.type.localeCompare(y.type) || x.id.localeCompare(y.id));
      for (const c of cands) if (!evidenced.has(`${c.type}:${c.id}`)) add('RC-09', c.type, c.id, c.label, { type: c.type, date: isoDay(c.date), amount: f2(c.amount) });
    }
    return { flags, evaluated };
  }

  /** The review checklist of the framework year starting `yearStart` (v2-plan 5h.2). */
  async checklist(tx: Tx, companyId: string, q: { yearStart: string }) {
    const fw = await this.framework(tx, companyId, q.yearStart);
    const s = await this.currentSettings(tx, companyId);
    const { flags, evaluated } = await this.raise(tx, companyId, fw, s);
    const responses = await tx.reviewFlagResponse.findMany({ where: { frameworkId: fw.id }, orderBy: [{ at: 'asc' }, { id: 'asc' }] });
    const byKey = new Map<string, typeof responses>();
    for (const r of responses) (byKey.get(r.flagKey) ?? byKey.set(r.flagKey, []).get(r.flagKey)!).push(r);
    const view = (r: (typeof responses)[number]) => ({ action: r.action, note: r.note, figures: r.figures as Figures, byUserId: r.byUserId, at: r.at });
    const controls = REVIEW_CONTROL_CODES.map((code) => {
      const mine = flags.filter((f) => f.control === code).map((f) => {
        const rs = byKey.get(f.key) ?? [];
        const st = flagState(rs, f.figures);
        return { ...f, state: st.state, changedSinceResponse: st.changed, responses: rs.map(view) };
      });
      const counts = { open: mine.filter((f) => f.state === 'OPEN').length, explained: mine.filter((f) => f.state === 'EXPLAINED').length, signedOff: mine.filter((f) => f.state === 'SIGNED_OFF').length };
      const status = !evaluated.has(code) ? 'NOT_EVALUATED' : mine.length === 0 ? 'CLEAR' : counts.open ? 'OPEN' : counts.explained ? 'EXPLAINED' : 'SIGNED_OFF';
      return { code, title: REVIEW_CONTROLS[code], status, needs: NEEDS[code] ?? [], counts, flags: mine };
    });
    const raised = new Set(flags.map((f) => f.key));
    const resolved = [...byKey.entries()].filter(([k]) => !raised.has(k)).map(([k, rs]) => ({ key: k, control: rs[0]!.control, lastAction: rs[rs.length - 1]!.action, responses: rs.map(view) }));
    const complete = controls.every((c) => c.status === 'CLEAR' || c.status === 'SIGNED_OFF');
    return {
      companyId, year: { start: isoDay(fw.yearStart), end: isoDay(fw.yearEnd), frameworkId: fw.id },
      settings: this.settingsView(await tx.reviewSetting.findFirst({ where: { companyId }, orderBy: [{ setAt: 'desc' }, { id: 'desc' }] })),
      controls, resolved, complete,
      notices: [
        'Flags are raised from the ledger (year-end closing journals left out), the registers and the documents each time the checklist is read; a flag that is no longer raised keeps its history under resolved (DEC-068).',
        ...(controls.some((c) => c.status === 'NOT_EVALUATED') ? ['Some controls are not evaluated because the firm\'s review settings they need are not set; they are never treated as passed.'] : []),
      ],
    };
  }

  // ───── Responses ─────
  private async current(tx: Tx, companyId: string, yearStart: string, flagKey: string) {
    const fw = await this.framework(tx, companyId, yearStart);
    assertYearOpen(fw);
    const { flags } = await this.raise(tx, companyId, fw, await this.currentSettings(tx, companyId));
    const flag = flags.find((f) => f.key === flagKey);
    if (!flag) throw notFound('This flag is not raised for the year (it may have been resolved, or its control is not evaluated)', 'flag_not_raised');
    const rs = await tx.reviewFlagResponse.findMany({ where: { frameworkId: fw.id, flagKey }, orderBy: [{ at: 'asc' }, { id: 'asc' }] });
    return { fw, flag, st: flagState(rs, flag.figures) };
  }
  private async respond(tx: Tx, a: Ctx & { yearStart: string; flagKey: string; note?: string }, action: 'EXPLAIN' | 'SIGN_OFF' | 'REOPEN', fw: { id: string }, flag: RaisedFlag) {
    const r = await tx.reviewFlagResponse.create({ data: { organisationId: a.organisationId, companyId: a.companyId, frameworkId: fw.id, flagKey: flag.key, control: flag.control, action,
      note: a.note ?? null, figures: flag.figures, byUserId: a.actor.userId! } });
    await this.audit(tx, { action: `accounts.review_flag_${action.toLowerCase()}`, organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'review_flag_response', entityId: r.id,
      after: { yearStart: a.yearStart, flagKey: flag.key, control: flag.control, figures: flag.figures, note: a.note ?? null } });
    return this.checklist(tx, a.companyId, { yearStart: a.yearStart });
  }
  async explain(tx: Tx, a: Ctx & { yearStart: string; flagKey: string; note: string }) {
    await this.need(a.actor, 'accounts:prepare', a.companyId);
    const { fw, flag } = await this.current(tx, a.companyId, a.yearStart, a.flagKey);
    return this.respond(tx, a, 'EXPLAIN', fw, flag);
  }
  async signOff(tx: Tx, a: Ctx & { yearStart: string; flagKey: string; note?: string }) {
    await this.need(a.actor, 'accounts:review', a.companyId);
    const { fw, flag, st } = await this.current(tx, a.companyId, a.yearStart, a.flagKey);
    if (st.state === 'SIGNED_OFF') throw conflict('This flag is already signed off', 'flag_signed_off');
    if (st.state !== 'EXPLAINED') throw unprocessable(st.changed ? 'The flag changed since it was explained; it needs a new explanation' : 'A flag is signed off only after it is explained', 'flag_not_explained');
    if (st.explainedBy === a.actor.userId) throw forbidden('A flag is signed off by someone other than the person who explained it', 'self_sign_off_not_allowed');
    return this.respond(tx, a, 'SIGN_OFF', fw, flag);
  }
  async reopen(tx: Tx, a: Ctx & { yearStart: string; flagKey: string; note: string }) {
    await this.need(a.actor, 'accounts:review', a.companyId);
    const { fw, flag, st } = await this.current(tx, a.companyId, a.yearStart, a.flagKey);
    if (st.state === 'OPEN') throw conflict('This flag is already open', 'flag_open');
    return this.respond(tx, a, 'REOPEN', fw, flag);
  }
}
