import { CLOSING_SOURCES } from '@uk/contracts';
import { AppError, conflict, forbidden, notFound, uuidv7 } from '@uk/core';
import type { Tx } from '@uk/db';
import { auditRow } from '@uk/platform';
import { addDays, addMonths } from './depreciation-math';
import { ZERO, fmt, money, type Money } from './money';
import type { PostLineInput, PostingActor, PostingService } from './posting';

/**
 * V2-M3b year-end closing journal (DEC-060; v2-plan section 5b). For a financial year aligned to accounting periods, one journal dated the year
 * end moves every income and expense account's net for the year to retained earnings. While it is live nothing posts income or expense into the
 * year (the PostingService refuses it, the database again); it is corrected only by its mirror. Statements leave closing journals out (reports.ts).
 */
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
const CLOSING: string[] = [...CLOSING_SOURCES];
type Ctx = { organisationId: string; companyId: string; actor: PostingActor };
type CloseRow = Awaited<ReturnType<Tx['yearEndClose']['findUniqueOrThrow']>>;
const L = (accountId: string, debit: Money, credit: Money, description: string): PostLineInput => ({ accountId, debit: debit.toFixed(4), credit: credit.toFixed(4), description: description.slice(0, 300) });
/** Why a close cannot post: the first one is raised by `close`, all are listed by the preview. */
type Blocker = { code: string; message: string; status: 409 | 422 };

export class YearEndCloseService {
  constructor(private readonly posting: PostingService, private readonly opts: { captureDeviceMetadata?: boolean } = {}) {}
  private audit(tx: Tx, e: Parameters<typeof auditRow>[0]) { return tx.auditEvent.createMany({ data: [auditRow(e, this.opts.captureDeviceMetadata)] }); }
  private async need(actor: PostingActor, companyId: string) {
    if (actor.kind !== 'USER') throw forbidden('Only a person can close a financial year', 'ai_cannot_post');
    if (!(await actor.can('accounts:prepare', companyId))) throw forbidden('Requires permission accounts:prepare', 'permission_denied');
  }
  private async minor(tx: Tx, companyId: string) {
    const c = await tx.company.findFirst({ where: { id: companyId }, select: { baseCurrency: true } });
    if (!c) throw notFound('Company not found');
    return (await tx.currency.findUnique({ where: { code: c.baseCurrency } }))?.minorUnits ?? 2;
  }
  /** Every posting takes this lock shared (PostingService 5a); the close takes it exclusively, so the year's balances cannot move under it. */
  private lock(tx: Tx, companyId: string) { return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'yearclose:' + companyId}, 0))`; }

  /** The closing journal the year would get now, the warnings, and every reason it cannot post. Writes nothing. */
  async preview(tx: Tx, companyId: string, q: { yearStart: string; yearEnd: string }) {
    const minor = await this.minor(tx, companyId);
    const p = await this.compute(tx, companyId, q);
    return {
      companyId, yearStart: q.yearStart, yearEnd: q.yearEnd, journalDate: q.yearEnd, retainedEarningsAccountId: p.re?.id ?? null, profit: fmt(p.profit, minor),
      lines: p.lines.map((l) => ({ accountId: l.accountId, code: l.code, name: l.name, debit: fmt(l.debit, minor), credit: fmt(l.credit, minor) })),
      warnings: p.warnings, canPost: p.blockers.length === 0, blockers: p.blockers.map(({ code, message }) => ({ code, message })),
      notice: 'The closing journal reverses each income and expense account\'s net for the year and puts the difference on retained earnings. While it is live nothing posts income or expense into the year; reverse it to change the year (DEC-060).',
    };
  }

  private async compute(tx: Tx, companyId: string, q: { yearStart: string; yearEnd: string }) {
    const blockers: Blocker[] = [];
    const block = (code: string, message: string, status: 409 | 422 = 422) => blockers.push({ code, message, status });
    if (q.yearEnd < q.yearStart) block('invalid_year', 'yearEnd cannot precede yearStart');
    // a financial year is at most 18 months (Companies Act 2006 s.390-392); the database repeats it
    if (q.yearEnd >= addMonths(q.yearStart, 18)) block('year_too_long', 'A financial year is at most 18 months long');
    // aligned to accounting periods that cover it without a gap
    const periods = await tx.accountingPeriod.findMany({ where: { companyId, startDate: { gte: toDate(q.yearStart) }, endDate: { lte: toDate(q.yearEnd) } }, orderBy: { startDate: 'asc' } });
    const gapless = periods.every((p, i) => i === 0 || isoDay(p.startDate) === addDays(isoDay(periods[i - 1]!.endDate), 1));
    if (periods.length === 0 || isoDay(periods[0]!.startDate) !== q.yearStart || isoDay(periods[periods.length - 1]!.endDate) !== q.yearEnd || !gapless)
      block('year_not_aligned', 'The year must start on the first day of an accounting period, end on the last day of one, and be covered by accounting periods without a gap');
    const last = periods[periods.length - 1];
    if (last && isoDay(last.endDate) === q.yearEnd && last.status !== 'OPEN')
      block(last.status === 'LOCKED' ? 'period_locked' : 'period_closed', `The accounting period ${isoDay(last.startDate)} to ${q.yearEnd} is ${last.status.toLowerCase()}; the closing journal is dated in it`);
    const overlap = await tx.yearEndClose.findFirst({ where: { companyId, status: 'POSTED', yearStart: { lte: toDate(q.yearEnd) }, yearEnd: { gte: toDate(q.yearStart) } } });
    if (overlap) {
      const same = isoDay(overlap.yearStart) === q.yearStart && isoDay(overlap.yearEnd) === q.yearEnd;
      block(same ? 'year_already_closed' : 'year_overlaps_close', same ? 'This financial year is already closed; reverse its close first' : `The year overlaps the live close of ${isoDay(overlap.yearStart)} to ${isoDay(overlap.yearEnd)}`, 409);
    }
    const re = await tx.account.findFirst({ where: { companyId, controlKind: 'RETAINED_EARNINGS' } });
    if (!re) block('retained_earnings_missing', 'The company has no retained-earnings account');
    // each income and expense account's net for the year over the whole ledger (a reversed close nets to nothing with its mirror)
    const rows = await tx.$queryRaw<{ account_id: string; code: string; name: string; active_to: Date | null; net: string }[]>`
      SELECT l.account_id, a.code, a.name, a.active_to, sum(l.debit - l.credit)::text AS net
        FROM journal_line l JOIN journal j ON j.id = l.journal_id AND j.organisation_id = l.organisation_id JOIN account a ON a.id = l.account_id AND a.organisation_id = l.organisation_id
       WHERE l.company_id = ${companyId}::uuid AND j.journal_date >= ${q.yearStart}::date AND j.journal_date <= ${q.yearEnd}::date AND a.type::text IN ('INCOME', 'EXPENSE')
       GROUP BY l.account_id, a.code, a.name, a.active_to ORDER BY a.code COLLATE "C"`;
    const lines: { accountId: string; code: string; name: string; debit: Money; credit: Money }[] = [];
    for (const r of rows) {
      const n = money(r.net);
      if (n.isZero()) continue;
      if (r.active_to && isoDay(r.active_to) < q.yearEnd) block('account_inactive', `Account ${r.code} carries a balance for the year but is inactive on ${q.yearEnd}`);
      lines.push({ accountId: r.account_id, code: r.code, name: r.name, debit: n.isNegative() ? n.negated() : ZERO, credit: n.isNegative() ? ZERO : n });
    }
    const profit = lines.reduce((t, l) => t.plus(l.debit).minus(l.credit), ZERO);
    if (lines.length === 0) block('nothing_to_close', 'No income or expense account carries a balance for the year');
    if (re && !profit.isZero()) lines.push({ accountId: re.id, code: re.code, name: re.name, debit: profit.isNegative() ? profit.negated() : ZERO, credit: profit.isNegative() ? ZERO : profit });
    // earlier income and expense that no live close covers: not an error (the first year may start before the books here), but worth knowing
    const [earlier] = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM journal_line l JOIN journal j ON j.id = l.journal_id AND j.organisation_id = l.organisation_id JOIN account a ON a.id = l.account_id AND a.organisation_id = l.organisation_id
       WHERE l.company_id = ${companyId}::uuid AND j.journal_date < ${q.yearStart}::date AND a.type::text IN ('INCOME', 'EXPENSE') AND j.source_type <> ALL(${CLOSING}::text[])
         AND NOT EXISTS (SELECT 1 FROM year_end_close c WHERE c.company_id = l.company_id AND c.organisation_id = l.organisation_id AND c.status = 'POSTED' AND j.journal_date BETWEEN c.year_start AND c.year_end)`;
    const warnings = Number(earlier?.n ?? 0) > 0 ? ['earlier_years_not_closed'] : [];
    return { lines, profit, re, warnings, blockers };
  }

  async close(tx: Tx, a: Ctx & { yearStart: string; yearEnd: string }) {
    await this.need(a.actor, a.companyId);
    await this.lock(tx, a.companyId);
    const p = await this.compute(tx, a.companyId, a);
    const b = p.blockers[0];
    if (b) throw new AppError(b.status, b.code, b.message);
    const id = uuidv7();
    const what = p.profit.isNegative() ? 'Loss' : 'Profit';
    const j = await this.posting.post(tx, { organisationId: a.organisationId, companyId: a.companyId, journalDate: a.yearEnd, sourceType: 'YEAR_END_CLOSE', sourceId: id, sourceReference: `YEC-${a.yearEnd}`,
      description: `Year-end close of the financial year ${a.yearStart} to ${a.yearEnd}`, idempotencyKey: `year-close:${id}`, actor: a.actor,
      lines: p.lines.map((l) => (l.accountId === p.re!.id ? L(l.accountId, l.debit, l.credit, `${what} for the year ${a.yearStart} to ${a.yearEnd}`) : L(l.accountId, l.debit, l.credit, `${l.code} closed to retained earnings`))) });
    await tx.yearEndClose.create({ data: { id, organisationId: a.organisationId, companyId: a.companyId, yearStart: toDate(a.yearStart), yearEnd: toDate(a.yearEnd), retainedEarningsAccountId: p.re!.id,
      journalId: j.id, profit: p.profit, createdByUserId: a.actor.userId! } });
    await this.audit(tx, { action: 'year_end.year_closed', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'year_end_close', entityId: id,
      after: { yearStart: a.yearStart, yearEnd: a.yearEnd, profit: p.profit.toFixed(2), journalId: j.id, accounts: p.lines.length } });
    return this.get(tx, a.companyId, id);
  }

  async reverse(tx: Tx, a: Ctx & { id: string; reason: string }) {
    await this.need(a.actor, a.companyId);
    await this.lock(tx, a.companyId);
    const c = await tx.yearEndClose.findFirst({ where: { id: a.id, companyId: a.companyId } });
    if (!c) throw notFound('Year-end close not found', 'close_not_found');
    if (c.status !== 'POSTED') throw conflict('This close is already reversed', 'close_reversed');
    const lines = await tx.journalLine.findMany({ where: { journalId: c.journalId }, orderBy: { lineNo: 'asc' } });
    const label = `the close of ${isoDay(c.yearStart)} to ${isoDay(c.yearEnd)}`;
    const j = await this.posting.post(tx, { organisationId: a.organisationId, companyId: a.companyId, journalDate: isoDay(c.yearEnd), sourceType: 'YEAR_END_CLOSE_REVERSAL', sourceId: c.id,
      sourceReference: `YEC-${isoDay(c.yearEnd)}`, description: `Reversal of ${label}: ${a.reason.trim()}`.slice(0, 500), idempotencyKey: `year-close-reversal:${c.id}`, actor: a.actor, reason: a.reason,
      lines: lines.map((l) => L(l.accountId, l.credit, l.debit, l.description ?? 'Reversed')) });
    await tx.yearEndClose.update({ where: { id: c.id }, data: { status: 'REVERSED', reversalJournalId: j.id, reversedByUserId: a.actor.userId!, reversedAt: new Date(), reversedReason: a.reason.trim() } });
    await this.audit(tx, { action: 'year_end.close_reversed', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'year_end_close', entityId: c.id,
      before: { status: 'POSTED' }, after: { status: 'REVERSED', reversalJournalId: j.id }, reason: a.reason });
    return this.get(tx, a.companyId, c.id);
  }

  private view(c: CloseRow, minor: number) {
    return { id: c.id, companyId: c.companyId, yearStart: isoDay(c.yearStart), yearEnd: isoDay(c.yearEnd), status: c.status, profit: fmt(c.profit, minor), retainedEarningsAccountId: c.retainedEarningsAccountId,
      journalId: c.journalId, reversalJournalId: c.reversalJournalId, createdByUserId: c.createdByUserId, createdAt: c.createdAt, reversedByUserId: c.reversedByUserId, reversedAt: c.reversedAt, reversedReason: c.reversedReason };
  }
  async list(tx: Tx, companyId: string, q: { status?: string }) {
    const minor = await this.minor(tx, companyId);
    const rows = await tx.yearEndClose.findMany({ where: { companyId, ...(q.status ? { status: q.status } : {}) }, orderBy: [{ yearStart: 'desc' }, { createdAt: 'desc' }] });
    return { items: rows.map((r) => this.view(r, minor)) };
  }
  /** One close with its journal lines, and the year's income less expenses with every journal included: zero while the close is live. */
  async get(tx: Tx, companyId: string, id: string) {
    const c = await tx.yearEndClose.findFirst({ where: { id, companyId } });
    if (!c) throw notFound('Year-end close not found', 'close_not_found');
    const minor = await this.minor(tx, companyId);
    const lines = await tx.journalLine.findMany({ where: { journalId: c.journalId }, orderBy: { lineNo: 'asc' } });
    const accounts = new Map((await tx.account.findMany({ where: { id: { in: lines.map((l) => l.accountId) } }, select: { id: true, code: true, name: true } })).map((x) => [x.id, x]));
    const [y] = await tx.$queryRaw<{ v: string | null }[]>`
      SELECT sum(l.credit - l.debit)::text AS v FROM journal_line l JOIN journal j ON j.id = l.journal_id AND j.organisation_id = l.organisation_id JOIN account a ON a.id = l.account_id AND a.organisation_id = l.organisation_id
       WHERE l.company_id = ${companyId}::uuid AND j.journal_date >= ${isoDay(c.yearStart)}::date AND j.journal_date <= ${isoDay(c.yearEnd)}::date AND a.type::text IN ('INCOME', 'EXPENSE')`;
    return { ...this.view(c, minor), yearIncomeLessExpensesIncludingClose: fmt(money(y?.v ?? '0'), minor),
      lines: lines.map((l) => ({ lineNo: l.lineNo, accountId: l.accountId, code: accounts.get(l.accountId)?.code ?? null, name: accounts.get(l.accountId)?.name ?? null, debit: fmt(l.debit, minor), credit: fmt(l.credit, minor), description: l.description })) };
  }
}
