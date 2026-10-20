import { DOCUMENT_SECTIONS, PRIOR_MET_VALUES, PRIOR_STATUS_VALUES, isEnteredFact, parseTemplate, type TemplateParagraph } from '@uk/contracts';
import { forbidden, notFound, unprocessable } from '@uk/core';
import type { Tx } from '@uk/db';
import { auditRow } from '@uk/platform';
import { CashFlowService } from './cash-flow';
import { addDays } from './depreciation-math';
import type { DirectorService } from './directors';
import { ZERO, money, type Money } from './money';
import type { PostingActor } from './posting';
import type { StatutoryReportService } from './statutory-report';
import type { YearEndService } from './year-end';

/**
 * V2-M5a (DEC-063; v2-plan section 5d): the accounts document. The statements come from the statutory preview (V2-M1); the policies, notes,
 * directors' report and balance-sheet statements are the version's wording (verified with it) filled from the ledger, the registers and the
 * preparer's facts. It reads; the only thing it writes is a preparer's fact.
 */
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** A date in full, as the wording shows it: 31 December 2026. */
export const longDate = (iso: string) => { const [y, m, d] = iso.split('-').map(Number) as [number, number, number]; return `${d} ${MONTHS[m - 1]} ${y}`; };
/** An amount as the wording shows it: two decimals, thousands separators, a minus sign for negatives. */
export const textAmount = (v: Money | string) => {
  const s = money(v).toFixed(2); const neg = s.startsWith('-'); const [i, f] = (neg ? s.slice(1) : s).split('.') as [string, string];
  return `${neg ? '-' : ''}${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${f}`;
};
const humanise = (code: string) => code.charAt(0) + code.slice(1).toLowerCase().replace(/_/g, ' ');
const names = (list: string[]) => (list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);
type Ctx = { organisationId: string; companyId: string; actor: PostingActor };
type Table = { columns: string[]; rows: string[][] };
type Block = { type: 'text'; text: string } | { type: 'table'; key: string; columns: string[]; rows: string[][] };

export class AccountsDocumentService {
  constructor(private readonly statutory: StatutoryReportService, private readonly directors: DirectorService, private readonly yearEnd: YearEndService,
    private readonly opts: { captureDeviceMetadata?: boolean } = {}) {}
  /** V2-M5c: the cash flow statement joins the statements when the version lists the year's size (DEC-067). It reads only. */
  private readonly cashFlow = new CashFlowService();
  private audit(tx: Tx, e: Parameters<typeof auditRow>[0]) { return tx.auditEvent.createMany({ data: [auditRow(e, this.opts.captureDeviceMetadata)] }); }
  private async framework(tx: Tx, companyId: string, yearStart: string) {
    const fw = await tx.companyReportingFramework.findFirst({ where: { companyId, yearStart: toDate(yearStart) } });
    if (!fw) throw notFound(`No reporting framework is set for the year starting ${yearStart}`, 'framework_not_set');
    return fw;
  }

  // ───── The preparer's facts ─────
  async setFact(tx: Tx, a: Ctx & { yearStart: string; key: string; value: string; reason: string }) {
    if (a.actor.kind !== 'USER') throw forbidden('Only a person can enter facts for the accounts', 'ai_cannot_write');
    if (!(await a.actor.can('accounts:prepare', a.companyId))) throw forbidden('Requires permission accounts:prepare', 'permission_denied');
    const fw = await this.framework(tx, a.companyId, a.yearStart);
    if (!isEnteredFact(a.key)) throw unprocessable('Not a known fact', 'unknown_fact');
    const value = a.value.trim();
    const bad = (why: string) => { throw unprocessable(`${a.key}: ${why}`, 'invalid_fact'); };
    if (a.key.startsWith('employees.') && !/^\d{1,7}$/.test(value)) bad('a whole number');
    if (a.key === 'approval.date' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || !new Date(value).toISOString().startsWith(value))) bad('a date (YYYY-MM-DD)');
    if (a.key === 'size.priorMet' && !(PRIOR_MET_VALUES as readonly string[]).includes(value)) bad(`one of ${PRIOR_MET_VALUES.join(', ')}`);
    if (a.key === 'size.priorStatus' && !(PRIOR_STATUS_VALUES as readonly string[]).includes(value)) bad(`one of ${PRIOR_STATUS_VALUES.join(', ')}`);
    if (a.key === 'approval.director' && (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
      || !(await tx.companyOfficer.findFirst({ where: { companyId: a.companyId, contactId: value, role: 'DIRECTOR' } })))) bad('a director of the company (a contact with a DIRECTOR appointment)');
    const row = await tx.accountsFact.create({ data: { organisationId: a.organisationId, companyId: a.companyId, frameworkId: fw.id, key: a.key, value, reason: a.reason.trim(), setByUserId: a.actor.userId! } });
    await this.audit(tx, { action: 'accounts.fact_set', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'accounts_fact', entityId: row.id,
      after: { yearStart: a.yearStart, key: a.key }, reason: a.reason });
    return this.facts(tx, a.companyId, a.yearStart);
  }
  async facts(tx: Tx, companyId: string, yearStart: string) {
    const fw = await this.framework(tx, companyId, yearStart);
    const rows = await tx.accountsFact.findMany({ where: { frameworkId: fw.id }, orderBy: [{ setAt: 'desc' }, { id: 'desc' }] });
    const current = new Map<string, (typeof rows)[number]>();
    for (const r of rows) if (!current.has(r.key)) current.set(r.key, r);
    const view = (r: (typeof rows)[number]) => ({ id: r.id, key: r.key, value: r.value, reason: r.reason, setByUserId: r.setByUserId, setAt: r.setAt });
    return { yearStart, frameworkId: fw.id, current: [...current.values()].sort((x, y) => x.key.localeCompare(y.key)).map(view), history: rows.map(view) };
  }

  // ───── Tables from the ledger and the registers ─────
  /** Fixed assets by class from the ledger (DEC-063): cost and depreciation brought forward, movements by source, carried forward. */
  private async fixedAssetTable(tx: Tx, companyId: string, start: string, end: string): Promise<Table> {
    const classes = await tx.fixedAssetClass.findMany({ where: { companyId }, orderBy: { code: 'asc' } });
    // classes sharing accounts are one column, so nothing is counted twice
    const groups = new Map<string, { name: string[]; cost: string; dep: string }>();
    for (const c of classes) {
      const k = `${c.costAccountId}|${c.depreciationAccountId}`;
      (groups.get(k) ?? groups.set(k, { name: [], cost: c.costAccountId, dep: c.depreciationAccountId }).get(k)!).name.push(c.name);
    }
    const ids = [...new Set(classes.flatMap((c) => [c.costAccountId, c.depreciationAccountId]))];
    const lines = ids.length === 0 ? [] : await tx.$queryRaw<{ account_id: string; source_type: string; before: boolean; d: string; c: string }[]>`
      SELECT l.account_id, j.source_type, j.journal_date < ${start}::date AS before, sum(l.debit)::text AS d, sum(l.credit)::text AS c
        FROM journal_line l JOIN journal j ON j.id = l.journal_id AND j.organisation_id = l.organisation_id
       WHERE l.company_id = ${companyId}::uuid AND l.account_id = ANY(${ids}::uuid[]) AND j.journal_date <= ${end}::date
       GROUP BY 1, 2, 3`;
    const sum = (acct: string, pick: (l: (typeof lines)[number]) => Money) => lines.filter((l) => l.account_id === acct).reduce((t, l) => t.plus(pick(l)), ZERO);
    const of = (sources: string[], side: 'd' | 'c') => (l: (typeof lines)[number]) => (!l.before && sources.includes(l.source_type) ? money(l[side]) : ZERO);
    const cols = [...groups.values()].map((g) => {
      const costBf = sum(g.cost, (l) => (l.before ? money(l.d).minus(l.c) : ZERO)), costCf = sum(g.cost, (l) => money(l.d).minus(l.c));
      const disposals = sum(g.cost, of(['FIXED_ASSET_DISPOSAL'], 'c')).minus(sum(g.cost, of(['FIXED_ASSET_DISPOSAL_REVERSAL'], 'd')));
      const depBf = sum(g.dep, (l) => (l.before ? money(l.c).minus(l.d) : ZERO)), depCf = sum(g.dep, (l) => money(l.c).minus(l.d));
      const charge = sum(g.dep, of(['FIXED_ASSET_DEPRECIATION', 'FIXED_ASSET_DISPOSAL'], 'c')).minus(sum(g.dep, of(['FIXED_ASSET_DEPRECIATION_REVERSAL', 'FIXED_ASSET_DISPOSAL_REVERSAL'], 'd')));
      const eliminated = sum(g.dep, of(['FIXED_ASSET_DISPOSAL'], 'd')).minus(sum(g.dep, of(['FIXED_ASSET_DISPOSAL_REVERSAL'], 'c')));
      return { name: g.name.join(' / '), v: [costBf, costCf.minus(costBf).plus(disposals), disposals.negated(), costCf, depBf, charge, eliminated.negated(), depCf.minus(depBf).minus(charge).plus(eliminated), depCf, costCf.minus(depCf), costBf.minus(depBf)] };
    }).filter((c) => c.v.some((x) => !x.isZero()));
    if (cols.length === 0) return { columns: [], rows: [] };
    const labels = [`Cost at ${longDate(start)}`, 'Additions', 'Disposals', `Cost at ${longDate(end)}`, `Depreciation at ${longDate(start)}`, 'Charge for the year', 'Eliminated on disposals', 'Other movements',
      `Depreciation at ${longDate(end)}`, `Net book value at ${longDate(end)}`, `Net book value at ${longDate(addDays(start, -1))}`];
    return { columns: ['', ...cols.map((c) => c.name), 'Total'],
      rows: labels.map((label, i) => [label, ...cols.map((c) => textAmount(c.v[i]!)), textAmount(cols.reduce((t, c) => t.plus(c.v[i]!), ZERO))]) };
  }
  private async tables(tx: Tx, companyId: string, start: string, end: string): Promise<Record<string, Table>> {
    const prov = await this.yearEnd.provisionReport(tx, companyId, { from: start, to: end });
    const adv = await this.directors.advancesSummary(tx, companyId, { from: start, to: end });
    const rp = await this.directors.relatedPartyReport(tx, companyId, { from: start, to: end });
    return {
      'fixedAssets.movements': await this.fixedAssetTable(tx, companyId, start, end),
      'provisions.movements': { columns: ['Provision', `At ${longDate(start)}`, 'Made', 'Used', 'Released', `At ${longDate(end)}`],
        rows: prov.provisions.filter((p) => [p.opening, p.made, p.used, p.released, p.closing].some((x) => !money(x).isZero())).map((p) => [p.name, ...[p.opening, p.made, p.used, p.released, p.closing].map(textAmount)]) },
      'directors.advances': { columns: ['Director', `At ${longDate(start)}`, 'Advanced', 'Credited or repaid', `At ${longDate(end)}`, 'Most overdrawn'],
        rows: adv.map((d) => [d.contactName ?? '', ...[d.opening, d.advanced, d.credited, d.closing, d.lowest].map(textAmount)]) },
      'relatedParties.transactions': { columns: ['Party', 'Relationship', 'Sales', 'Purchases', 'Cash paid', 'Cash received', 'Owed by', 'Owed to', 'Loan account'],
        rows: rp.items.map((p) => [p.contactName ?? '', humanise(p.relationship), ...[p.figures.sales.amount, p.figures.purchases.amount, p.figures.cashPaid.amount, p.figures.cashReceived.amount, p.figures.owedBy.amount, p.figures.owedTo.amount].map(textAmount),
          textAmount(p.figures.loanAccounts.reduce((t, l) => t.plus(money(l.closing)), ZERO))]) },
    };
  }

  // ───── The document ─────
  async document(tx: Tx, companyId: string, q: { yearStart: string }) {
    const fw = await this.framework(tx, companyId, q.yearStart);
    const start = isoDay(fw.yearStart), end = isoDay(fw.yearEnd), priorEnd = addDays(start, -1);
    const preview = await this.statutory.preview(tx, companyId, { yearStart: start, compare: true });
    const company = await tx.company.findFirstOrThrow({ where: { id: companyId }, select: { name: true, companyNumber: true, baseCurrency: true } });
    const values = new Map<string, { amount: string | null; comparative?: string | null }>();
    for (const l of [...preview.statements.profitAndLoss, ...preview.statements.balanceSheet]) values.set(l.key, l);
    const facts = new Map((await this.facts(tx, companyId, start)).current.map((f) => [f.key, f.value]));
    const officers = await tx.companyOfficer.findMany({ where: { companyId, role: 'DIRECTOR', appointedOn: { lte: fw.yearEnd }, OR: [{ resignedOn: null }, { resignedOn: { gte: fw.yearStart } }] },
      orderBy: [{ appointedOn: 'asc' }, { createdAt: 'asc' }], include: { contact: { select: { id: true, name: true } } } });
    const directorNames = [...new Set(officers.map((o) => o.contact.name))];
    const tables = await this.tables(tx, companyId, start, end);
    const rules = (await tx.disclosureRule.findMany({ where: { versionId: fw.versionId, removed: false } }))
      .sort((x, y) => DOCUMENT_SECTIONS.indexOf(x.section as never) - DOCUMENT_SECTIONS.indexOf(y.section as never) || x.sort - y.sort || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
    const problems: string[] = [], omitted: { key: string; title: string; reason: 'NOT_APPLICABLE' | 'EMPTY' }[] = [];
    const sections = new Map<string, { key: string; title: string; blocks: Block[]; missing: string[] }[]>();
    const lineValue = (key: string, prior: boolean) => { const v = values.get(key); return prior ? v?.comparative : v?.amount; };
    for (const r of rules) {
      if (!r.appliesTo.includes(fw.entitySize)) { omitted.push({ key: r.key, title: r.title, reason: 'NOT_APPLICABLE' }); continue; }
      if (!r.body) { problems.push(`${r.key}: no wording`); (sections.get(r.section) ?? sections.set(r.section, []).get(r.section)!).push({ key: r.key, title: r.title, blocks: [], missing: [] }); continue; }
      const t = parseTemplate(r.body);
      if (r.omitWhenEmpty && (t.tables.length || t.lines.length) && t.tables.every((k) => tables[k]!.rows.length === 0) && t.lines.every((k) => money(lineValue(k, false) ?? '0').isZero())) {
        omitted.push({ key: r.key, title: r.title, reason: 'EMPTY' }); continue;
      }
      const missing: string[] = [];
      const scalar = (scope: string, key: string): string => {
        const need = (v: string | null | undefined, name: string) => { if (v) return v; missing.push(name); return `[missing: ${name}]`; };
        if (scope === 'company') return need(key === 'name' ? company.name : company.companyNumber, `company.${key}`);
        if (scope === 'year') return longDate(key === 'start' ? start : key === 'end' ? end : priorEnd);
        if (scope === 'standard') return preview.standard.name;
        if (scope === 'version') return preview.version.label;
        return need(names(directorNames), 'directors');
      };
      const factText = (key: string) => {
        const v = facts.get(key);
        if (v === undefined) { missing.push(key); return `[missing: ${key}]`; }
        if (key === 'approval.date') return longDate(v);
        if (key === 'approval.director') return officers.find((o) => o.contact.id === v)?.contact.name ?? v;
        return v;
      };
      const blocks: Block[] = t.paragraphs.map((p: TemplateParagraph): Block => {
        if (p.kind === 'table') return { type: 'table', key: p.key, ...tables[p.key]! };
        return { type: 'text', text: p.parts.map((x) => (x.kind === 'text' ? x.text : x.kind === 'fact' ? factText(x.key) : x.kind === 'scalar' ? scalar(x.scope, x.key)
          : (() => { const v = lineValue(x.key, x.prior); if (v === null || v === undefined) { missing.push(`line ${x.key}${x.prior ? ' (prior)' : ''}`); return `[missing: ${x.key}]`; } return textAmount(v); })())).join('') };
      });
      for (const m of missing) problems.push(`${r.key}: missing fact ${m}`);
      (sections.get(r.section) ?? sections.set(r.section, []).get(r.section)!).push({ key: r.key, title: r.title, blocks, missing });
    }
    // the statements' own problems count too: unplaced accounts, failed error rules, an unbalanced balance sheet
    if (preview.unplacedAccounts.length) problems.push(`Statements: ${preview.unplacedAccounts.length} account(s) not placed on a statutory line`);
    if (preview.validationSummary.errors) problems.push(`Statements: ${preview.validationSummary.errors} validation rule(s) failed`);
    if (!preview.reconciliation.balanceSheet.balanced) problems.push('Statements: the balance sheet does not balance');
    for (const p of preview.problems) problems.push(`Statements: ${p}`);
    const version = await tx.reportingStandardVersion.findFirstOrThrow({ where: { id: fw.versionId }, select: { cashFlowAppliesTo: true } });
    const cashFlow = version.cashFlowAppliesTo.includes(fw.entitySize) ? await this.cashFlow.statement(tx, companyId, { yearStart: start, compare: true }) : null;
    if (cashFlow) {
      for (const p of cashFlow.problems) problems.push(`Cash flow: ${p}`);
      if (!cashFlow.proof.reconciled) problems.push('Cash flow: the statement does not reconcile to the movement in cash');
    }
    return {
      companyId, companyName: company.name, companyNumber: company.companyNumber, currency: company.baseCurrency,
      year: { start, end, priorEnd, entitySize: fw.entitySize, frameworkId: fw.id }, standard: preview.standard, version: preview.version, verified: preview.verified,
      statements: { ...preview.statements, cashFlow }, reconciliation: preview.reconciliation, validations: preview.validations,
      sections: DOCUMENT_SECTIONS.filter((s) => sections.has(s)).map((s) => ({ section: s, items: sections.get(s)! })),
      omitted, problems, complete: preview.verified && problems.length === 0,
      notices: [...preview.notices, 'Amounts in the wording have two decimals and thousands separators; dates are in full. The output is text and tables, never markup.'],
    };
  }
}
