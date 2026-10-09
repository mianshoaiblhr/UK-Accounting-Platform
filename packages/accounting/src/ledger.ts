import { DEBIT_NORMAL, type AccountType } from '@uk/contracts';
import { notFound, unprocessable } from '@uk/core';
import type { Tx } from '@uk/db';
import { ZERO, fmt, money, type Money } from './money';

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
const MAX_DAY = '9999-12-31', MIN_DAY = '0001-01-01';
const natural = (type: AccountType | string, debit: Money, credit: Money): Money => (DEBIT_NORMAL.includes(type as AccountType) ? debit.minus(credit) : credit.minus(debit));

async function minorUnits(tx: Tx, companyId: string): Promise<{ minor: number; currency: string }> {
  const c = await tx.company.findUnique({ where: { id: companyId }, select: { baseCurrency: true } });
  if (!c) throw notFound('Company not found');
  const cur = await tx.currency.findUnique({ where: { code: c.baseCurrency } });
  return { minor: cur?.minorUnits ?? 2, currency: c.baseCurrency };
}

/**
 * Read side of the ledger (ADR-48). Everything here aggregates `journal_line`; nothing reads a source document table, so a report can never
 * disagree with the ledger. Every figure carries what is needed to drill down: report -> account -> journal -> source reference.
 */
export class LedgerQueries {
  async listJournals(tx: Tx, companyId: string, q: { limit: number; cursor?: string; from?: string; to?: string; source?: string; accountId?: string }) {
    const { minor, currency } = await minorUnits(tx, companyId);
    const cursor = q.cursor ? Number(q.cursor) : undefined;
    if (q.cursor && !Number.isInteger(cursor)) throw unprocessable('Invalid cursor', 'invalid_cursor');
    const rows = await tx.journal.findMany({ where: { companyId, ...(cursor ? { journalNumber: { lt: cursor } } : {}), ...(q.from || q.to ? { journalDate: { ...(q.from ? { gte: toDate(q.from) } : {}), ...(q.to ? { lte: toDate(q.to) } : {}) } } : {}),
      ...(q.source ? { sourceType: q.source } : {}), ...(q.accountId ? { lines: { some: { accountId: q.accountId } } } : {}) }, orderBy: { journalNumber: 'desc' }, take: q.limit + 1 });
    const page = rows.slice(0, q.limit);
    const reversedBy = new Map((await tx.journal.findMany({ where: { companyId, reversesJournalId: { in: page.map((j) => j.id) } }, select: { id: true, reversesJournalId: true, journalNumber: true } })).map((r) => [r.reversesJournalId!, r]));
    return { currency, items: page.map((j) => this.header(j, minor, reversedBy.get(j.id))), nextCursor: rows.length > q.limit ? String(page[page.length - 1]!.journalNumber) : null };
  }

  async getJournal(tx: Tx, companyId: string, id: string) {
    const { minor, currency } = await minorUnits(tx, companyId);
    const j = await tx.journal.findFirst({ where: { id, companyId }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
    if (!j) throw notFound('Journal not found');
    const accounts = new Map((await tx.account.findMany({ where: { companyId, id: { in: j.lines.map((l) => l.accountId) } } })).map((a) => [a.id, a]));
    const reversedBy = await tx.journal.findFirst({ where: { companyId, reversesJournalId: j.id }, select: { id: true, reversesJournalId: true, journalNumber: true } });
    const reverses = j.reversesJournalId ? await tx.journal.findFirst({ where: { id: j.reversesJournalId }, select: { id: true, journalNumber: true } }) : null;
    return { currency, ...this.header(j, minor, reversedBy ?? undefined), reverses: reverses ? { journalId: reverses.id, journalNumber: reverses.journalNumber } : null,
      lines: j.lines.map((l) => { const a = accounts.get(l.accountId); return { lineNo: l.lineNo, accountId: l.accountId, accountCode: a?.code ?? null, accountName: a?.name ?? null, debit: fmt(l.debit, minor), credit: fmt(l.credit, minor), description: l.description }; }) };
  }

  private header(j: { id: string; journalNumber: number; journalDate: Date; periodId: string; sourceType: string; sourceId: string | null; sourceReference: string | null; description: string; total: Money; lineCount: number; actorType: string; postedByUserId: string | null; postedAt: Date; reversesJournalId: string | null },
    minor: number, reversedBy?: { id: string; journalNumber: number }) {
    return { id: j.id, journalNumber: j.journalNumber, journalDate: isoDay(j.journalDate), periodId: j.periodId, sourceType: j.sourceType, sourceId: j.sourceId, sourceReference: j.sourceReference, description: j.description,
      total: fmt(j.total, minor), lineCount: j.lineCount, actorType: j.actorType, postedByUserId: j.postedByUserId, postedAt: j.postedAt, reversesJournalId: j.reversesJournalId,
      reversedByJournalId: reversedBy?.id ?? null, reversedByJournalNumber: reversedBy?.journalNumber ?? null };
  }

  /** General ledger for one account with a running balance (natural side: positive = the account's normal side). Keyset pagination; the running balance is recomputed server-side for every page. */
  async generalLedger(tx: Tx, companyId: string, q: { accountId: string; from?: string; to?: string; limit: number; cursor?: string }) {
    const { minor, currency } = await minorUnits(tx, companyId);
    const account = await tx.account.findFirst({ where: { id: q.accountId, companyId } });
    if (!account) throw notFound('Account not found');
    const from = q.from ?? MIN_DAY, to = q.to ?? MAX_DAY;
    let after = { d: MIN_DAY, n: 0, l: 0 };
    if (q.cursor) {
      const m = /^(\d{4}-\d{2}-\d{2})\|(\d+)\|(\d+)$/.exec(q.cursor);
      if (!m) throw unprocessable('Invalid cursor', 'invalid_cursor');
      after = { d: m[1]!, n: Number(m[2]), l: Number(m[3]) };
    }
    const sum = async (whereSql: 'opening' | 'consumed') => {
      const r = whereSql === 'opening'
        ? await tx.$queryRaw<{ d: string | null; c: string | null }[]>`
            SELECT sum(l.debit)::text AS d, sum(l.credit)::text AS c FROM journal_line l JOIN journal j ON j.id = l.journal_id AND j.organisation_id = l.organisation_id
             WHERE l.company_id = ${companyId}::uuid AND l.account_id = ${q.accountId}::uuid AND j.journal_date < ${from}::date`
        : await tx.$queryRaw<{ d: string | null; c: string | null }[]>`
            SELECT sum(l.debit)::text AS d, sum(l.credit)::text AS c FROM journal_line l JOIN journal j ON j.id = l.journal_id AND j.organisation_id = l.organisation_id
             WHERE l.company_id = ${companyId}::uuid AND l.account_id = ${q.accountId}::uuid AND j.journal_date >= ${from}::date AND j.journal_date <= ${to}::date
               AND (j.journal_date, j.journal_number, l.line_no) <= (${after.d}::date, ${after.n}::int, ${after.l}::int)`;
      return { d: money(r[0]?.d ?? '0'), c: money(r[0]?.c ?? '0') };
    };
    const opening = await sum('opening');
    const consumed = q.cursor ? await sum('consumed') : { d: ZERO, c: ZERO };
    const page = await tx.$queryRaw<{ journal_id: string; journal_number: number; journal_date: Date; line_no: number; debit: string; credit: string; line_description: string | null; description: string; source_type: string; source_id: string | null; source_reference: string | null }[]>`
      SELECT j.id AS journal_id, j.journal_number, j.journal_date, l.line_no, l.debit::text AS debit, l.credit::text AS credit, l.description AS line_description, j.description, j.source_type, j.source_id, j.source_reference
        FROM journal_line l JOIN journal j ON j.id = l.journal_id AND j.organisation_id = l.organisation_id
       WHERE l.company_id = ${companyId}::uuid AND l.account_id = ${q.accountId}::uuid AND j.journal_date >= ${from}::date AND j.journal_date <= ${to}::date
         AND (j.journal_date, j.journal_number, l.line_no) > (${after.d}::date, ${after.n}::int, ${after.l}::int)
       ORDER BY j.journal_date, j.journal_number, l.line_no LIMIT ${q.limit + 1}`;
    const rows = page.slice(0, q.limit);
    let run = natural(account.type, opening.d.plus(consumed.d), opening.c.plus(consumed.c));
    const items = rows.map((r) => {
      const debit = money(r.debit), credit = money(r.credit);
      run = run.plus(natural(account.type, debit, credit));
      return { journalId: r.journal_id, journalNumber: r.journal_number, journalDate: isoDay(r.journal_date), lineNo: r.line_no, description: r.line_description ?? r.description, sourceType: r.source_type, sourceId: r.source_id, sourceReference: r.source_reference,
        debit: fmt(debit, minor), credit: fmt(credit, minor), balance: fmt(run, minor) };
    });
    const last = rows[rows.length - 1];
    return { currency, account: { id: account.id, code: account.code, name: account.name, type: account.type }, from: q.from ?? null, to: q.to ?? null,
      openingBalance: fmt(natural(account.type, opening.d, opening.c), minor), items, nextCursor: page.length > q.limit && last ? `${isoDay(last.journal_date)}|${last.journal_number}|${last.line_no}` : null };
  }

  /**
   * Trial balance as at a date (default today) or at the end of a period (with that period's movement). Cumulative from the first posting; no
   * year-end closing of P&L accounts yet (V2). Warns about non-zero suspense balances. Reads journal lines only.
   */
  async trialBalance(tx: Tx, companyId: string, q: { periodId?: string; asOf?: string }) {
    const { minor, currency } = await minorUnits(tx, companyId);
    let asOf = q.asOf ?? new Date().toISOString().slice(0, 10);
    let period: { id: string; startDate: Date; endDate: Date; status: string } | null = null;
    if (q.periodId) {
      period = await tx.accountingPeriod.findFirst({ where: { id: q.periodId, companyId } });
      if (!period) throw notFound('Accounting period not found');
      asOf = isoDay(period.endDate);
    }
    const totals = await tx.$queryRaw<{ account_id: string; d: string; c: string }[]>`
      SELECT l.account_id, sum(l.debit)::text AS d, sum(l.credit)::text AS c FROM journal_line l JOIN journal j ON j.id = l.journal_id AND j.organisation_id = l.organisation_id
       WHERE l.company_id = ${companyId}::uuid AND j.journal_date <= ${asOf}::date GROUP BY l.account_id`;
    const movement = period ? await tx.$queryRaw<{ account_id: string; d: string; c: string }[]>`
      SELECT l.account_id, sum(l.debit)::text AS d, sum(l.credit)::text AS c FROM journal_line l JOIN journal j ON j.id = l.journal_id AND j.organisation_id = l.organisation_id
       WHERE l.company_id = ${companyId}::uuid AND j.journal_date >= ${isoDay(period.startDate)}::date AND j.journal_date <= ${asOf}::date GROUP BY l.account_id` : [];
    const mov = new Map(movement.map((m) => [m.account_id, m]));
    const tot = new Map(totals.map((t) => [t.account_id, t]));
    const accounts = await tx.account.findMany({ where: { companyId, id: { in: [...tot.keys()] } }, orderBy: { code: 'asc' } });
    let td = ZERO, tc = ZERO;
    const warnings: { code: string; accountId: string; accountCode: string; message: string; balance: string }[] = [];
    const rows = accounts.map((a) => {
      const t = tot.get(a.id)!;
      const net = money(t.d).minus(money(t.c));
      const debit = net.greaterThan(0) ? net : ZERO, credit = net.lessThan(0) ? net.negated() : ZERO;
      td = td.plus(debit); tc = tc.plus(credit);
      if (a.controlKind === 'SUSPENSE' && !net.isZero()) warnings.push({ code: 'suspense_balance', accountId: a.id, accountCode: a.code, message: `Suspense account ${a.code} has a balance of ${fmt(net.abs(), minor)}; clear it before closing the period`, balance: fmt(net, minor) });
      const m = mov.get(a.id);
      return { accountId: a.id, code: a.code, name: a.name, type: a.type, subtype: a.subtype, reportingMapping: a.reportingMapping, debit: fmt(debit, minor), credit: fmt(credit, minor),
        ...(period ? { movementDebit: fmt(money(m?.d ?? '0'), minor), movementCredit: fmt(money(m?.c ?? '0'), minor) } : {}),
        drilldown: { accountId: a.id, from: null, to: asOf } };
    });
    return { currency, asOf, period: period ? { id: period.id, startDate: isoDay(period.startDate), endDate: isoDay(period.endDate), status: period.status } : null, rows,
      totalDebit: fmt(td, minor), totalCredit: fmt(tc, minor), balanced: td.equals(tc), warnings };
  }
}
