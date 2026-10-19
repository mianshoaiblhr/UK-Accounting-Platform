import { LOAN_ACCOUNT_KINDS, type LOAN_MOVEMENT_CATEGORIES, type RELATIONSHIPS } from '@uk/contracts';
import { conflict, forbidden, notFound, unprocessable, uuidv7 } from '@uk/core';
import { Prisma, type Tx } from '@uk/db';
import { auditRow } from '@uk/platform';
import { addDays, daysInclusive } from './depreciation-math';
import { ZERO, fmt, money, type Money } from './money';
import type { PostingActor } from './posting';

/**
 * V2-M4 (DEC-062; v2-plan section 5c): director and shareholder loan accounts with their statements and review flags, and the related-party
 * register with its year report. Registers over the ledger only: this module reads journal lines and never writes a journal.
 * Loan balances are credit-positive: positive means the company owes the person, negative means the account is overdrawn.
 */
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
type Category = (typeof LOAN_MOVEMENT_CATEGORIES)[number];
type Ctx = { organisationId: string; companyId: string; actor: PostingActor };
type LoanRow = Awaited<ReturnType<Tx['directorLoanAccount']['findUniqueOrThrow']>>;
type PartyRow = Awaited<ReturnType<Tx['relatedParty']['findUniqueOrThrow']>>;
const DIRECTOR_KINDS: string[] = [LOAN_ACCOUNT_KINDS[0], LOAN_ACCOUNT_KINDS[2]];

/** The category of one other line of a loan-account journal; null for a VAT line, which never decides the category. */
export function lineCategory(a: { type: string; subtype: string; controlKind: string | null; isLoanAccount: boolean }): Category | null {
  if (a.controlKind === 'VAT_CONTROL') return null;
  if (a.isLoanAccount) return 'OTHER_LOAN_ACCOUNT';
  if (a.subtype === 'CURRENT_ASSET_BANK' || a.subtype === 'CURRENT_ASSET_CASH') return 'CASH_AND_BANK';
  if (a.subtype === 'DIVIDENDS') return 'DIVIDENDS';
  if (a.type === 'EXPENSE') return 'EXPENSES';
  if (a.type === 'INCOME') return 'INCOME';
  return 'OTHER';
}
/** A journal's category: the one category all its other lines share, else MIXED (OTHER when it has only VAT lines). */
export function movementCategory(cats: (Category | null)[]): Category {
  const set = new Set(cats.filter((c): c is Category => c !== null));
  return set.size === 1 ? [...set][0]! : set.size === 0 ? 'OTHER' : 'MIXED';
}
/** Day-end balances over [from, to]: the lowest (and the first day it holds) and the number of days the account ends overdrawn. */
export function dayEndStats(opening: Money, moves: { date: string; balance: Money }[], from: string, to: string) {
  // the balance at the end of each day that has movements; days between hold the previous day's balance
  const ends = new Map<string, Money>();
  for (const m of moves) ends.set(m.date, m.balance);
  const dates = [...ends.keys()].sort();
  let lowest: Money | null = null, lowestOn = from, days = 0;
  const segment = (start: string, end: string, b: Money) => {
    if (end < start) return;
    if (lowest === null || b.lessThan(lowest)) { lowest = b; lowestOn = start; }
    if (b.isNegative()) days += daysInclusive(start, end);
  };
  segment(from, dates.length ? addDays(dates[0]!, -1) : to, opening);
  dates.forEach((d, i) => segment(d, i + 1 < dates.length ? addDays(dates[i + 1]!, -1) : to, ends.get(d)!));
  return { lowest: lowest ?? opening, lowestOn, daysOverdrawn: days };
}

export class DirectorService {
  constructor(private readonly opts: { captureDeviceMetadata?: boolean } = {}) {}
  private audit(tx: Tx, e: Parameters<typeof auditRow>[0]) { return tx.auditEvent.createMany({ data: [auditRow(e, this.opts.captureDeviceMetadata)] }); }
  private async need(actor: PostingActor, companyId: string) {
    if (actor.kind !== 'USER') throw forbidden('Only a person can maintain loan accounts and related parties', 'ai_cannot_write');
    if (!(await actor.can('accounts:prepare', companyId))) throw forbidden('Requires permission accounts:prepare', 'permission_denied');
  }
  private async minor(tx: Tx, companyId: string) {
    const c = await tx.company.findFirst({ where: { id: companyId }, select: { baseCurrency: true } });
    if (!c) throw notFound('Company not found');
    return (await tx.currency.findUnique({ where: { code: c.baseCurrency } }))?.minorUnits ?? 2;
  }
  private async contact(tx: Tx, companyId: string, id: string) {
    const c = await tx.contact.findFirst({ where: { id, OR: [{ companyId: null }, { companyId }] }, select: { id: true, name: true, kind: true } });
    if (!c) throw unprocessable('The contact does not exist for this company', 'unknown_contact');
    return c;
  }

  // ───── Loan accounts ─────
  async createLoanAccount(tx: Tx, a: Ctx & { contactId: string; kind: string; accountId: string; openedOn: string; notes?: string }) {
    await this.need(a.actor, a.companyId);
    await this.contact(tx, a.companyId, a.contactId);
    const acc = await tx.account.findFirst({ where: { id: a.accountId, companyId: a.companyId } });
    if (!acc) throw unprocessable('The ledger account does not exist in this company', 'unknown_account');
    if (acc.isControl || !['ASSET', 'LIABILITY'].includes(acc.type) || ['CURRENT_ASSET_BANK', 'CURRENT_ASSET_CASH'].includes(acc.subtype))
      throw unprocessable(`Account ${acc.code} cannot hold a loan account: it must be a non-control asset or liability account that is not bank or cash`, 'invalid_loan_account');
    if (DIRECTOR_KINDS.includes(a.kind) && !(await tx.companyOfficer.findFirst({ where: { companyId: a.companyId, contactId: a.contactId, role: 'DIRECTOR' } })))
      throw unprocessable('The person has no DIRECTOR appointment in this company; record the appointment first, or use the SHAREHOLDER kind', 'not_a_director');
    const id = uuidv7();
    try {
      await tx.directorLoanAccount.create({ data: { id, organisationId: a.organisationId, companyId: a.companyId, contactId: a.contactId, kind: a.kind, accountId: a.accountId, openedOn: toDate(a.openedOn),
        notes: a.notes ?? null, createdByUserId: a.actor.userId! } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('The person or the ledger account already has a live loan account', 'loan_account_exists');
      throw e;
    }
    await this.audit(tx, { action: 'directors.loan_account_created', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'director_loan_account', entityId: id,
      after: { contactId: a.contactId, kind: a.kind, accountId: a.accountId, openedOn: a.openedOn } });
    return this.getLoanAccount(tx, a.companyId, id);
  }
  async closeLoanAccount(tx: Tx, a: Ctx & { id: string; closedOn: string; reason: string }) {
    await this.need(a.actor, a.companyId);
    const l = await tx.directorLoanAccount.findFirst({ where: { id: a.id, companyId: a.companyId } });
    if (!l) throw notFound('Loan account not found', 'loan_account_not_found');
    if (l.status !== 'ACTIVE') throw conflict('This loan account is already closed', 'loan_account_closed');
    if (a.closedOn < isoDay(l.openedOn)) throw unprocessable('A loan account cannot close before it opened', 'invalid_date');
    await tx.directorLoanAccount.update({ where: { id: l.id }, data: { status: 'CLOSED', closedOn: toDate(a.closedOn), closedReason: a.reason.trim(), closedByUserId: a.actor.userId! } });
    await this.audit(tx, { action: 'directors.loan_account_closed', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'director_loan_account', entityId: l.id,
      before: { status: 'ACTIVE' }, after: { status: 'CLOSED', closedOn: a.closedOn }, reason: a.reason });
    return this.getLoanAccount(tx, a.companyId, l.id);
  }
  private async loanView(tx: Tx, rows: LoanRow[]) {
    const contacts = new Map((await tx.contact.findMany({ where: { id: { in: rows.map((r) => r.contactId) } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
    const accounts = new Map((await tx.account.findMany({ where: { id: { in: rows.map((r) => r.accountId) } }, select: { id: true, code: true, name: true } })).map((c) => [c.id, c]));
    return rows.map((r) => ({ id: r.id, companyId: r.companyId, contactId: r.contactId, contactName: contacts.get(r.contactId) ?? null, kind: r.kind, accountId: r.accountId,
      accountCode: accounts.get(r.accountId)?.code ?? null, accountName: accounts.get(r.accountId)?.name ?? null, openedOn: isoDay(r.openedOn), notes: r.notes, status: r.status,
      closedOn: r.closedOn ? isoDay(r.closedOn) : null, closedReason: r.closedReason, closedByUserId: r.closedByUserId, createdByUserId: r.createdByUserId, createdAt: r.createdAt }));
  }
  async listLoanAccounts(tx: Tx, companyId: string, q: { status?: string }) {
    const rows = await tx.directorLoanAccount.findMany({ where: { companyId, ...(q.status ? { status: q.status } : {}) }, orderBy: [{ openedOn: 'asc' }, { createdAt: 'asc' }] });
    return { items: await this.loanView(tx, rows) };
  }
  async getLoanAccount(tx: Tx, companyId: string, id: string, range?: { from: string; to: string }) {
    const l = await tx.directorLoanAccount.findFirst({ where: { id, companyId } });
    if (!l) throw notFound('Loan account not found', 'loan_account_not_found');
    const [view] = await this.loanView(tx, [l]);
    return { ...view!, ...(range ? { statement: await this.statement(tx, companyId, l, range.from, range.to) } : {}) };
  }

  // ───── Thresholds (the firm's review settings, versioned) ─────
  private async currentThresholds(tx: Tx, companyId: string) {
    return tx.directorLoanThreshold.findFirst({ where: { companyId }, orderBy: [{ setAt: 'desc' }, { id: 'desc' }] });
  }
  async getThresholds(tx: Tx, companyId: string) {
    const minor = await this.minor(tx, companyId);
    const rows = await tx.directorLoanThreshold.findMany({ where: { companyId }, orderBy: [{ setAt: 'desc' }, { id: 'desc' }] });
    const view = (r: (typeof rows)[number]) => ({ id: r.id, largeMovement: r.largeMovement ? fmt(r.largeMovement, minor) : null, overdrawn: r.overdrawn ? fmt(r.overdrawn, minor) : null, reason: r.reason, setByUserId: r.setByUserId, setAt: r.setAt });
    return { current: rows[0] ? view(rows[0]) : null, history: rows.map(view),
      notice: 'Review thresholds set by the firm for this client. They prompt a review; they are not legal limits (no Companies Act or tax amount is encoded here).' };
  }
  async setThresholds(tx: Tx, a: Ctx & { largeMovement: string | null; overdrawn: string | null; reason: string }) {
    await this.need(a.actor, a.companyId);
    const row = await tx.directorLoanThreshold.create({ data: { organisationId: a.organisationId, companyId: a.companyId, largeMovement: a.largeMovement, overdrawn: a.overdrawn, reason: a.reason.trim(), setByUserId: a.actor.userId! } });
    await this.audit(tx, { action: 'directors.thresholds_set', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'director_loan_threshold', entityId: row.id,
      after: { largeMovement: a.largeMovement, overdrawn: a.overdrawn }, reason: a.reason });
    return this.getThresholds(tx, a.companyId);
  }

  // ───── Statements ─────
  private async statement(tx: Tx, companyId: string, l: LoanRow, from: string, to: string) {
    if (to < from) throw unprocessable('to cannot precede from', 'invalid_date');
    const minor = await this.minor(tx, companyId);
    const f = (m: Money) => fmt(m, minor);
    const [op] = await tx.$queryRaw<{ v: string | null }[]>`
      SELECT sum(l.credit - l.debit)::text AS v FROM journal_line l JOIN journal j ON j.id = l.journal_id AND j.organisation_id = l.organisation_id
       WHERE l.company_id = ${companyId}::uuid AND l.account_id = ${l.accountId}::uuid AND j.journal_date < ${from}::date`;
    const opening = money(op?.v ?? '0');
    const js = await tx.$queryRaw<{ id: string; journal_number: number; journal_date: Date; source_type: string; description: string; amount: string }[]>`
      SELECT j.id, j.journal_number, j.journal_date, j.source_type, j.description, sum(l.credit - l.debit)::text AS amount
        FROM journal_line l JOIN journal j ON j.id = l.journal_id AND j.organisation_id = l.organisation_id
       WHERE l.company_id = ${companyId}::uuid AND l.account_id = ${l.accountId}::uuid AND j.journal_date >= ${from}::date AND j.journal_date <= ${to}::date
       GROUP BY j.id, j.journal_number, j.journal_date, j.source_type, j.description ORDER BY j.journal_date, j.journal_number`;
    const ids = js.filter((j) => !money(j.amount).isZero()).map((j) => j.id);
    const loanAccounts = new Set((await tx.directorLoanAccount.findMany({ where: { companyId }, select: { accountId: true } })).map((x) => x.accountId));
    const others = ids.length === 0 ? [] : await tx.$queryRaw<{ journal_id: string; type: string; subtype: string; control_kind: string | null; account_id: string }[]>`
      SELECT DISTINCT l.journal_id, a.type::text AS type, a.subtype, a.control_kind, l.account_id FROM journal_line l JOIN account a ON a.id = l.account_id AND a.organisation_id = l.organisation_id
       WHERE l.journal_id = ANY(${ids}::uuid[]) AND l.account_id <> ${l.accountId}::uuid`;
    const cats = new Map<string, (Category | null)[]>();
    for (const o of others) (cats.get(o.journal_id) ?? cats.set(o.journal_id, []).get(o.journal_id)!).push(lineCategory({ type: o.type, subtype: o.subtype, controlKind: o.control_kind, isLoanAccount: loanAccounts.has(o.account_id) }));
    let bal = opening;
    const moves = js.filter((j) => !money(j.amount).isZero()).map((j) => {
      const amount = money(j.amount); bal = bal.plus(amount);
      return { journalId: j.id, journalNumber: j.journal_number, date: isoDay(j.journal_date), sourceType: j.source_type, description: j.description, amount, category: movementCategory(cats.get(j.id) ?? []), balance: bal };
    });
    const stats = dayEndStats(opening, moves, from, to);
    const byCategory = new Map<Category, Money>();
    for (const m of moves) byCategory.set(m.category, (byCategory.get(m.category) ?? ZERO).plus(m.amount));
    // review flags (DEC-062): prompts for the reviewer; a threshold not set is "not evaluated", never passed
    const th = await this.currentThresholds(tx, companyId);
    const flags: string[] = [], notEvaluated: string[] = [];
    if (bal.isNegative()) flags.push('OVERDRAWN_AT_END');
    if (stats.lowest.isNegative()) flags.push('OVERDRAWN_IN_PERIOD');
    const large = th?.largeMovement ? moves.filter((m) => m.amount.abs().greaterThanOrEqualTo(th.largeMovement!)) : [];
    if (!th?.largeMovement) notEvaluated.push('LARGE_MOVEMENT'); else if (large.length) flags.push('LARGE_MOVEMENT');
    if (!th?.overdrawn) notEvaluated.push('OVERDRAWN_ABOVE_THRESHOLD'); else if (stats.lowest.isNegative() && stats.lowest.negated().greaterThanOrEqualTo(th.overdrawn)) flags.push('OVERDRAWN_ABOVE_THRESHOLD');
    return {
      from, to, opening: f(opening), closing: f(bal), lowest: f(stats.lowest), lowestOn: stats.lowestOn, daysOverdrawn: stats.daysOverdrawn,
      movements: moves.map((m) => ({ ...m, amount: f(m.amount), balance: f(m.balance) })),
      byCategory: [...byCategory.entries()].map(([category, v]) => ({ category, amount: f(v) })),
      flags, notEvaluated, largeMovementJournalIds: large.map((m) => m.journalId),
      thresholds: th ? { largeMovement: th.largeMovement ? f(th.largeMovement) : null, overdrawn: th.overdrawn ? f(th.overdrawn) : null, setAt: th.setAt } : null,
      drilldown: { accountId: l.accountId, from, to },
      notice: 'Balances are credit-positive: negative means the person owes the company (overdrawn). Flags are review prompts on the firm\'s thresholds, not legal conclusions.',
    };
  }
  async loanStatement(tx: Tx, companyId: string, id: string, q: { from: string; to: string }) { return this.getLoanAccount(tx, companyId, id, q); }
  /** Every loan account open at some point in the range, with its statement summary and flags. */
  async loanReport(tx: Tx, companyId: string, q: { from: string; to: string }) {
    const rows = await tx.directorLoanAccount.findMany({ where: { companyId, openedOn: { lte: toDate(q.to) }, OR: [{ closedOn: null }, { closedOn: { gte: toDate(q.from) } }] }, orderBy: [{ openedOn: 'asc' }, { createdAt: 'asc' }] });
    const views = await this.loanView(tx, rows);
    const items = [];
    for (const [i, r] of rows.entries()) {
      const { movements, ...s } = await this.statement(tx, companyId, r, q.from, q.to);
      items.push({ ...views[i]!, ...s, movementCount: movements.length });
    }
    return { companyId, from: q.from, to: q.to, items, flagged: items.filter((x) => x.flags.length > 0).length };
  }

  /** Per director's loan account open in the range (V2-M5a note on advances and credits): opening, advanced, credited or repaid, closing, lowest. */
  async advancesSummary(tx: Tx, companyId: string, q: { from: string; to: string }) {
    const minor = await this.minor(tx, companyId);
    const rows = await tx.directorLoanAccount.findMany({ where: { companyId, kind: { in: DIRECTOR_KINDS }, openedOn: { lte: toDate(q.to) }, OR: [{ closedOn: null }, { closedOn: { gte: toDate(q.from) } }] },
      orderBy: [{ openedOn: 'asc' }, { createdAt: 'asc' }] });
    const views = await this.loanView(tx, rows);
    const out = [];
    for (const [i, r] of rows.entries()) {
      const s = await this.statement(tx, companyId, r, q.from, q.to);
      const amounts = s.movements.map((m) => money(m.amount));
      out.push({ loanAccountId: r.id, contactId: r.contactId, contactName: views[i]!.contactName, opening: s.opening, closing: s.closing, lowest: s.lowest,
        advanced: fmt(amounts.filter((x) => x.isNegative()).reduce((t, x) => t.minus(x), ZERO), minor), credited: fmt(amounts.filter((x) => x.greaterThan(0)).reduce((t, x) => t.plus(x), ZERO), minor) });
    }
    return out;
  }

  // ───── Related parties ─────
  async createRelatedParty(tx: Tx, a: Ctx & { contactId: string; relationship: (typeof RELATIONSHIPS)[number]; description: string; fromDate: string }) {
    await this.need(a.actor, a.companyId);
    await this.contact(tx, a.companyId, a.contactId);
    const id = uuidv7();
    try {
      await tx.relatedParty.create({ data: { id, organisationId: a.organisationId, companyId: a.companyId, contactId: a.contactId, relationship: a.relationship, description: a.description.trim(), fromDate: toDate(a.fromDate), createdByUserId: a.actor.userId! } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('This counterparty already has a live entry for this relationship', 'related_party_exists');
      throw e;
    }
    await this.audit(tx, { action: 'directors.related_party_created', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'related_party', entityId: id,
      after: { contactId: a.contactId, relationship: a.relationship, fromDate: a.fromDate } });
    return this.getRelatedParty(tx, a.companyId, id);
  }
  async endRelatedParty(tx: Tx, a: Ctx & { id: string; toDate: string; reason: string }) {
    await this.need(a.actor, a.companyId);
    const p = await tx.relatedParty.findFirst({ where: { id: a.id, companyId: a.companyId } });
    if (!p) throw notFound('Related party not found', 'related_party_not_found');
    if (p.status !== 'ACTIVE') throw conflict('This related party is already ended', 'related_party_ended');
    if (a.toDate < isoDay(p.fromDate)) throw unprocessable('A relationship cannot end before it began', 'invalid_date');
    await tx.relatedParty.update({ where: { id: p.id }, data: { status: 'ENDED', toDate: toDate(a.toDate), endedReason: a.reason.trim(), endedByUserId: a.actor.userId!, endedAt: new Date() } });
    await this.audit(tx, { action: 'directors.related_party_ended', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'related_party', entityId: p.id,
      before: { status: 'ACTIVE' }, after: { status: 'ENDED', toDate: a.toDate }, reason: a.reason });
    return this.getRelatedParty(tx, a.companyId, p.id);
  }
  private async partyView(tx: Tx, rows: PartyRow[]) {
    const contacts = new Map((await tx.contact.findMany({ where: { id: { in: rows.map((r) => r.contactId) } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
    return rows.map((r) => ({ id: r.id, companyId: r.companyId, contactId: r.contactId, contactName: contacts.get(r.contactId) ?? null, relationship: r.relationship, description: r.description,
      fromDate: isoDay(r.fromDate), toDate: r.toDate ? isoDay(r.toDate) : null, status: r.status, endedReason: r.endedReason, endedByUserId: r.endedByUserId, endedAt: r.endedAt,
      createdByUserId: r.createdByUserId, createdAt: r.createdAt }));
  }
  async listRelatedParties(tx: Tx, companyId: string, q: { status?: string }) {
    const rows = await tx.relatedParty.findMany({ where: { companyId, ...(q.status ? { status: q.status } : {}) }, orderBy: [{ fromDate: 'asc' }, { createdAt: 'asc' }] });
    return { items: await this.partyView(tx, rows) };
  }
  async getRelatedParty(tx: Tx, companyId: string, id: string) {
    const p = await tx.relatedParty.findFirst({ where: { id, companyId } });
    if (!p) throw notFound('Related party not found', 'related_party_not_found');
    return (await this.partyView(tx, [p]))[0]!;
  }

  /** The counterparty's journals: its sales and purchase documents, receipts, payments, their reversals, exchange differences on allocation, and cash transactions. */
  private async counterpartyLines(tx: Tx, companyId: string, contactId: string, to: string) {
    return tx.$queryRaw<{ journal_id: string; journal_number: number; journal_date: Date; source_type: string; account_id: string; is_control: boolean; control_kind: string | null; d: string; c: string }[]>`
      WITH src(jid) AS (
        SELECT journal_id FROM sales_document WHERE company_id = ${companyId}::uuid AND contact_id = ${contactId}::uuid AND journal_id IS NOT NULL
        UNION SELECT journal_id FROM sales_receipt WHERE company_id = ${companyId}::uuid AND contact_id = ${contactId}::uuid
        UNION SELECT reversal_journal_id FROM sales_receipt WHERE company_id = ${companyId}::uuid AND contact_id = ${contactId}::uuid AND reversal_journal_id IS NOT NULL
        UNION SELECT a.fx_journal_id FROM sales_allocation a JOIN sales_document d ON d.id = a.invoice_id AND d.organisation_id = a.organisation_id
               WHERE a.company_id = ${companyId}::uuid AND d.contact_id = ${contactId}::uuid AND a.fx_journal_id IS NOT NULL
        UNION SELECT journal_id FROM purchase_document WHERE company_id = ${companyId}::uuid AND contact_id = ${contactId}::uuid AND journal_id IS NOT NULL
        UNION SELECT journal_id FROM purchase_payment WHERE company_id = ${companyId}::uuid AND contact_id = ${contactId}::uuid
        UNION SELECT reversal_journal_id FROM purchase_payment WHERE company_id = ${companyId}::uuid AND contact_id = ${contactId}::uuid AND reversal_journal_id IS NOT NULL
        UNION SELECT a.fx_journal_id FROM purchase_allocation a JOIN purchase_document d ON d.id = a.bill_id AND d.organisation_id = a.organisation_id
               WHERE a.company_id = ${companyId}::uuid AND d.contact_id = ${contactId}::uuid AND a.fx_journal_id IS NOT NULL
        UNION SELECT journal_id FROM cash_transaction WHERE company_id = ${companyId}::uuid AND contact_id = ${contactId}::uuid
        UNION SELECT reversal_journal_id FROM cash_transaction WHERE company_id = ${companyId}::uuid AND contact_id = ${contactId}::uuid AND reversal_journal_id IS NOT NULL)
      SELECT j.id AS journal_id, j.journal_number, j.journal_date, j.source_type, l.account_id, a.is_control, a.control_kind, sum(l.debit)::text AS d, sum(l.credit)::text AS c
        FROM src JOIN journal j ON j.id = src.jid JOIN journal_line l ON l.journal_id = j.id AND l.organisation_id = j.organisation_id JOIN account a ON a.id = l.account_id AND a.organisation_id = l.organisation_id
       WHERE j.company_id = ${companyId}::uuid AND j.journal_date <= ${to}::date
       GROUP BY j.id, j.journal_number, j.journal_date, j.source_type, l.account_id, a.is_control, a.control_kind ORDER BY j.journal_date, j.journal_number`;
  }
  /** Per related party in the register during the range: sales, purchases, cash paid and received, owed by and owed to at the end, loan accounts. */
  async relatedPartyReport(tx: Tx, companyId: string, q: { from: string; to: string }) {
    if (q.to < q.from) throw unprocessable('to cannot precede from', 'invalid_date');
    const minor = await this.minor(tx, companyId);
    const f = (m: Money) => fmt(m, minor);
    const parties = await tx.relatedParty.findMany({ where: { companyId, fromDate: { lte: toDate(q.to) }, OR: [{ toDate: null }, { toDate: { gte: toDate(q.from) } }] }, orderBy: [{ fromDate: 'asc' }, { createdAt: 'asc' }] });
    const views = await this.partyView(tx, parties);
    const loanAccounts = await tx.directorLoanAccount.findMany({ where: { companyId } });
    const loanAccountIds = new Set(loanAccounts.map((l) => l.accountId));
    type Fig = { amount: string; journals: { journalId: string; journalNumber: number; journalDate: string; sourceType: string; amount: string }[] };
    type Figures = { sales: Fig; purchases: Fig; cashPaid: Fig; cashReceived: Fig; owedBy: Fig; owedTo: Fig; loanAccounts: { id: string; accountId: string; closing: string; lowest: string; flags: string[] }[] };
    const cache = new Map<string, Figures>();
    const figures = async (contactId: string): Promise<Figures> => {
      const hit = cache.get(contactId);
      if (hit) return hit;
      const lines = await this.counterpartyLines(tx, companyId, contactId, q.to);
      const inRange = (d: Date) => isoDay(d) >= q.from;
      type J = { journalId: string; journalNumber: number; journalDate: string; sourceType: string; amount: Money };
      const sum = (pick: (l: (typeof lines)[number]) => Money | null) => {
        const by = new Map<string, J>();
        for (const l of lines) {
          const v = pick(l);
          if (v === null) continue;
          const j = by.get(l.journal_id) ?? { journalId: l.journal_id, journalNumber: l.journal_number, journalDate: isoDay(l.journal_date), sourceType: l.source_type, amount: ZERO };
          j.amount = j.amount.plus(v); by.set(l.journal_id, j);
        }
        const js = [...by.values()].filter((j) => !j.amount.isZero());
        return { total: js.reduce((t, j) => t.plus(j.amount), ZERO), journals: js };
      };
      const net = (l: (typeof lines)[number]) => money(l.d).minus(money(l.c));
      const of = (sources: string[], sign: 1 | -1, o: { excludeLoans?: boolean } = {}) => sum((l) => (sources.includes(l.source_type) && inRange(l.journal_date) && !l.is_control && !(o.excludeLoans && loanAccountIds.has(l.account_id)) ? (sign === 1 ? net(l) : net(l).negated()) : null));
      const control = (kind: string, sign: 1 | -1) => sum((l) => (l.control_kind === kind ? (sign === 1 ? net(l) : net(l).negated()) : null));
      const out = (s: { total: Money; journals: J[] }) => ({ amount: f(s.total), journals: s.journals.map((j) => ({ ...j, amount: f(j.amount) })) });
      const result = {
        sales: out(of(['SALES_INVOICE', 'SALES_CREDIT_NOTE'], -1)),
        purchases: out(of(['PURCHASE_BILL', 'PURCHASE_DEBIT_NOTE'], 1)),
        // a loan account's own lines are loan movements, never cash paid or received
        cashPaid: out(of(['CASH_PAYMENT', 'CASH_PAYMENT_REVERSAL'], 1, { excludeLoans: true })),
        cashReceived: out(of(['CASH_RECEIPT', 'CASH_RECEIPT_REVERSAL'], -1, { excludeLoans: true })),
        owedBy: out(control('TRADE_RECEIVABLES', 1)),
        owedTo: out(control('TRADE_PAYABLES', -1)),
        loanAccounts: [] as { id: string; accountId: string; closing: string; lowest: string; flags: string[] }[],
      };
      for (const l of loanAccounts.filter((x) => x.contactId === contactId && isoDay(x.openedOn) <= q.to)) {
        const s = await this.statement(tx, companyId, l, q.from, q.to);
        result.loanAccounts.push({ id: l.id, accountId: l.accountId, closing: s.closing, lowest: s.lowest, flags: s.flags });
      }
      cache.set(contactId, result);
      return result;
    };
    const items = [];
    for (const v of views) items.push({ ...v, figures: await figures(v.contactId) });
    return { companyId, from: q.from, to: q.to, items,
      notice: 'Figures from the ledger in the base currency: sales and purchases net of VAT from the counterparty\'s documents, cash from its cash transactions, balances from the control accounts at the end. Transactions posted only by manual journal are not attributed to a counterparty. What the notes disclose is decided by the reporting framework (V2-M5).' };
  }
}
