import type { YearEndItemKind } from '@uk/contracts';
import { AppError, conflict, forbidden, notFound, unprocessable, uuidv7 } from '@uk/core';
import { Prisma, type Tx } from '@uk/db';
import { auditRow } from '@uk/platform';
import { addDays, daysInclusive, monthsCounted } from './depreciation-math';
import { ZERO, fmt, money, type Money } from './money';
import type { PostLineInput, PostingActor, PostingService } from './posting';

/**
 * V2-M3a year-end adjustments (DEC-059; v2-plan section 5). Accruals and accrued income (posted with their next-day reversal), prepayments and
 * deferred income (released by schedule through release runs), provisions (made, used, released). Every ledger effect goes through the
 * PostingService under its own journal source and is corrected only by its own mirror; the database repeats the rules.
 */
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
export const YEAR_END_SOURCES = ['ACCRUAL', 'ACCRUAL_AUTO_REVERSAL', 'ACCRUAL_CANCELLATION', 'ADJUSTMENT_SETUP', 'ADJUSTMENT_SETUP_REVERSAL', 'ADJUSTMENT_RELEASE', 'ADJUSTMENT_RELEASE_REVERSAL', 'PROVISION_MOVEMENT', 'PROVISION_MOVEMENT_REVERSAL'];
const SCHEDULES = ['PREPAYMENT', 'DEFERRED_INCOME'];
/** The account types each kind needs: [P&L side, balance side]. */
const KIND_TYPES: Record<YearEndItemKind, [string, string]> = { ACCRUAL: ['EXPENSE', 'LIABILITY'], ACCRUED_INCOME: ['INCOME', 'ASSET'], PREPAYMENT: ['EXPENSE', 'ASSET'], DEFERRED_INCOME: ['INCOME', 'LIABILITY'] };

type ItemRow = Awaited<ReturnType<Tx['yearEndItem']['findUniqueOrThrow']>>;
type MovementRow = Awaited<ReturnType<Tx['provisionMovement']['findUniqueOrThrow']>>;
type Ctx = { organisationId: string; companyId: string; actor: PostingActor };
const L = (accountId: string, debit: Money, credit: Money, description: string): PostLineInput => ({ accountId, debit: debit.toFixed(4), credit: credit.toFixed(4), description: description.slice(0, 300) });

/** How much of a schedule is due for release at `d` (straight line over its service period; unrounded). */
export function releaseDue(i: { amount: Money; periodStart: string; periodEnd: string; convention: string }, d: string): Money {
  if (d < i.periodStart) return ZERO;
  if (i.convention === 'DAILY') {
    const total = daysInclusive(i.periodStart, i.periodEnd);
    return i.amount.mul(Math.min(daysInclusive(i.periodStart, d), total)).div(total);
  }
  const [sy, sm] = i.periodStart.split('-').map(Number) as [number, number];
  const [ey, em] = i.periodEnd.split('-').map(Number) as [number, number];
  const total = (ey - sy) * 12 + (em - sm) + 1;
  return i.amount.mul(Math.min(monthsCounted(i.periodStart, d), total)).div(total);
}

export class YearEndService {
  constructor(private readonly posting: PostingService, private readonly opts: { captureDeviceMetadata?: boolean } = {}) {}
  private audit(tx: Tx, e: Parameters<typeof auditRow>[0]) { return tx.auditEvent.createMany({ data: [auditRow(e, this.opts.captureDeviceMetadata)] }); }
  private async need(actor: PostingActor, companyId: string) {
    if (actor.kind !== 'USER') throw forbidden('Only a person can post year-end adjustments', 'ai_cannot_post');
    if (!(await actor.can('accounts:prepare', companyId))) throw forbidden('Requires permission accounts:prepare', 'permission_denied');
  }
  private async minor(tx: Tx, companyId: string) {
    const c = await tx.company.findFirst({ where: { id: companyId }, select: { baseCurrency: true } });
    if (!c) throw notFound('Company not found');
    return (await tx.currency.findUnique({ where: { code: c.baseCurrency } }))?.minorUnits ?? 2;
  }
  private async account(tx: Tx, companyId: string, id: string, type: string, what: string) {
    const a = await tx.account.findFirst({ where: { id, companyId } });
    if (!a) throw unprocessable(`The ${what} does not exist in this company`, 'unknown_account');
    if (a.isControl) throw unprocessable(`The ${what} ${a.code} is a control account, maintained by its own module`, 'control_account_restricted');
    if (a.type !== type) throw unprocessable(`The ${what} must be an ${type.toLowerCase()} account (${a.code} is ${a.type.toLowerCase()})`, 'invalid_item_account');
    return a;
  }
  private post(tx: Tx, c: Ctx, o: { date: string; source: string; sourceId: string; ref: string; description: string; lines: PostLineInput[]; key: string; reason?: string }) {
    return this.posting.post(tx, { organisationId: c.organisationId, companyId: c.companyId, journalDate: o.date, sourceType: o.source, sourceId: o.sourceId, sourceReference: o.ref,
      description: o.description.slice(0, 500), lines: o.lines, idempotencyKey: o.key, actor: c.actor, reason: o.reason ?? null });
  }
  private async mirror(tx: Tx, c: Ctx, o: { journalId: string; date: string; source: string; sourceId: string; ref: string; label: string; reason: string; key: string }) {
    const lines = await tx.journalLine.findMany({ where: { journalId: o.journalId }, orderBy: { lineNo: 'asc' } });
    return this.post(tx, c, { date: o.date, source: o.source, sourceId: o.sourceId, ref: o.ref, description: `Reversal of ${o.label}: ${o.reason.trim()}`, key: o.key, reason: o.reason,
      lines: lines.map((l) => L(l.accountId, l.credit, l.debit, l.description ?? 'Reversed')) });
  }

  // ───── Items ─────
  private itemView(i: ItemRow, minor: number, released?: Money) {
    const schedule = SCHEDULES.includes(i.kind);
    return { id: i.id, companyId: i.companyId, kind: i.kind, description: i.description, amount: fmt(i.amount, minor), plAccountId: i.plAccountId, balanceAccountId: i.balanceAccountId,
      date: isoDay(i.itemDate), periodStart: i.periodStart ? isoDay(i.periodStart) : null, periodEnd: i.periodEnd ? isoDay(i.periodEnd) : null, convention: i.convention, setupKind: i.setupKind,
      setupJournalId: i.setupJournalId, accrualJournalId: i.accrualJournalId, autoReversalJournalId: i.autoReversalJournalId, status: i.status, cancellationJournalIds: i.cancellationJournalIds,
      cancelledByUserId: i.cancelledByUserId, cancelledAt: i.cancelledAt, cancelledReason: i.cancelledReason, basis: i.basis, evidenceDocumentIds: i.evidenceDocumentIds, createdByUserId: i.createdByUserId,
      createdAt: i.createdAt, ...(schedule && released ? { released: fmt(released, minor), unreleased: fmt(i.status === 'ACTIVE' ? i.amount.minus(released) : ZERO, minor) } : {}) };
  }
  private async released(tx: Tx, itemIds: string[], asAt?: string) {
    if (itemIds.length === 0) return new Map<string, Money>();
    const rows = await tx.$queryRaw<{ item_id: string; amount: string }[]>`
      SELECT l.item_id, sum(l.amount)::text AS amount FROM release_run_line l JOIN release_run r ON r.id = l.run_id AND r.organisation_id = l.organisation_id
       WHERE l.item_id = ANY(${itemIds}::uuid[]) AND r.status = 'POSTED' ${asAt ? Prisma.sql`AND r.as_at <= ${asAt}::date` : Prisma.empty} GROUP BY l.item_id`;
    return new Map(rows.map((r) => [r.item_id, money(r.amount)]));
  }
  /** The net a journal put on an account on the side the kind needs, less what items already link to it. */
  private async linkable(tx: Tx, companyId: string, journalId: string, accountId: string, debitSide: boolean) {
    const j = await tx.journal.findFirst({ where: { id: journalId, companyId } });
    if (!j) throw unprocessable('The journal does not exist in this company', 'unknown_journal');
    if (YEAR_END_SOURCES.includes(j.sourceType)) throw unprocessable('A journal posted by the year-end register cannot be linked again', 'journal_not_linkable');
    if (await tx.journal.findFirst({ where: { reversesJournalId: j.id }, select: { id: true } })) throw unprocessable('The journal has been reversed', 'journal_not_linkable');
    const lines = await tx.journalLine.findMany({ where: { journalId: j.id, accountId }, select: { debit: true, credit: true } });
    const net = lines.reduce((t, l) => (debitSide ? t.plus(l.debit).minus(l.credit) : t.plus(l.credit).minus(l.debit)), ZERO);
    const used = (await tx.yearEndItem.findMany({ where: { setupJournalId: j.id, setupKind: 'LINKED', status: 'ACTIVE' }, select: { amount: true } })).reduce((t, x) => t.plus(x.amount), ZERO);
    return net.minus(used);
  }
  async createItem(tx: Tx, a: Ctx & { kind: YearEndItemKind; date: string; description: string; amount: string; plAccountId: string; balanceAccountId: string; basis?: string; evidenceDocumentIds: string[];
    periodStart?: string; periodEnd?: string; convention?: string; setup?: { kind: 'POSTED' } | { kind: 'LINKED'; journalId: string } }) {
    await this.need(a.actor, a.companyId);
    const minor = await this.minor(tx, a.companyId);
    const amount = money(a.amount);
    if (amount.decimalPlaces() > minor) throw unprocessable(`Amounts have at most ${minor} decimal places`, 'invalid_amount');
    const [plType, balType] = KIND_TYPES[a.kind];
    const pl = await this.account(tx, a.companyId, a.plAccountId, plType, 'P&L account');
    const bal = await this.account(tx, a.companyId, a.balanceAccountId, balType, 'balance account');
    if (a.evidenceDocumentIds.length && (await tx.document.count({ where: { id: { in: a.evidenceDocumentIds }, companyId: a.companyId } })) !== a.evidenceDocumentIds.length) throw unprocessable('An evidence document does not belong to this company', 'unknown_document');
    const id = uuidv7();
    const c: Ctx = a;
    const ref = `YE-${a.kind}`;
    const data: Prisma.YearEndItemUncheckedCreateInput = { id, organisationId: a.organisationId, companyId: a.companyId, kind: a.kind, description: a.description, amount, plAccountId: pl.id, balanceAccountId: bal.id,
      itemDate: toDate(a.date), basis: a.basis ?? null, evidenceDocumentIds: a.evidenceDocumentIds, createdByUserId: a.actor.userId! };
    if (a.kind === 'ACCRUAL' || a.kind === 'ACCRUED_INCOME') {
      const lines = a.kind === 'ACCRUAL' ? [L(pl.id, amount, ZERO, a.description), L(bal.id, ZERO, amount, a.description)] : [L(bal.id, amount, ZERO, a.description), L(pl.id, ZERO, amount, a.description)];
      const j = await this.post(tx, c, { date: a.date, source: 'ACCRUAL', sourceId: id, ref, description: `${a.kind === 'ACCRUAL' ? 'Accrual' : 'Accrued income'}: ${a.description}`, lines, key: `accrual:${id}` });
      const next = addDays(a.date, 1);
      let r;
      try {
        r = await this.post(tx, c, { date: next, source: 'ACCRUAL_AUTO_REVERSAL', sourceId: id, ref, description: `Automatic reversal of: ${a.description}`, key: `accrual-reversal:${id}`,
          lines: lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit })) });
      } catch (e) {
        if (e instanceof AppError && e.code === 'no_period') throw unprocessable(`The reversal falls on ${next}, which no accounting period covers; create the next period first`, 'next_period_missing');
        throw e;
      }
      Object.assign(data, { accrualJournalId: j.id, autoReversalJournalId: r.id });
    } else {
      const ps = a.periodStart!, pe = a.periodEnd!;
      let setupJournalId: string;
      if (a.setup!.kind === 'POSTED') {
        const lines = a.kind === 'PREPAYMENT' ? [L(bal.id, amount, ZERO, a.description), L(pl.id, ZERO, amount, a.description)] : [L(pl.id, amount, ZERO, a.description), L(bal.id, ZERO, amount, a.description)];
        setupJournalId = (await this.post(tx, c, { date: a.date, source: 'ADJUSTMENT_SETUP', sourceId: id, ref, description: `${a.kind === 'PREPAYMENT' ? 'Prepayment' : 'Deferred income'} set up: ${a.description}`, lines, key: `adjustment-setup:${id}` })).id;
      } else {
        const available = await this.linkable(tx, a.companyId, a.setup!.journalId, bal.id, a.kind === 'PREPAYMENT');
        if (available.lessThan(amount)) throw unprocessable(`The journal puts ${fmt(available, minor)} not yet linked on the balance account, less than ${fmt(amount, minor)}`, 'link_amount_exceeded');
        setupJournalId = a.setup!.journalId;
      }
      Object.assign(data, { periodStart: toDate(ps), periodEnd: toDate(pe), convention: a.convention ?? 'MONTHLY', setupKind: a.setup!.kind, setupJournalId });
    }
    const item = await tx.yearEndItem.create({ data });
    await this.audit(tx, { action: 'year_end.item_created', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'year_end_item', entityId: id, after: this.itemView(item, minor) });
    return this.getItem(tx, a.companyId, id);
  }
  async getItem(tx: Tx, companyId: string, id: string) {
    const i = await tx.yearEndItem.findFirst({ where: { id, companyId } });
    if (!i) throw notFound('Year-end item not found', 'item_not_found');
    const minor = await this.minor(tx, companyId);
    return this.itemView(i, minor, SCHEDULES.includes(i.kind) ? ((await this.released(tx, [i.id])).get(i.id) ?? ZERO) : undefined);
  }
  async listItems(tx: Tx, companyId: string, q: { kind?: string; status?: string }) {
    const minor = await this.minor(tx, companyId);
    const rows = await tx.yearEndItem.findMany({ where: { companyId, ...(q.kind ? { kind: q.kind } : {}), ...(q.status ? { status: q.status } : {}) }, orderBy: [{ itemDate: 'asc' }, { createdAt: 'asc' }] });
    const rel = await this.released(tx, rows.filter((r) => SCHEDULES.includes(r.kind)).map((r) => r.id));
    return { items: rows.map((r) => this.itemView(r, minor, SCHEDULES.includes(r.kind) ? (rel.get(r.id) ?? ZERO) : undefined)) };
  }
  /** A wrong item is cancelled by mirrors at its own dates: an accrual and its reversal; a posted set-up before anything is released; a linked schedule posts nothing. */
  async cancelItem(tx: Tx, a: Ctx & { id: string; reason: string }) {
    await this.need(a.actor, a.companyId);
    await tx.$queryRaw`SELECT id FROM year_end_item WHERE id = ${a.id}::uuid FOR UPDATE`;
    const i = await tx.yearEndItem.findFirst({ where: { id: a.id, companyId: a.companyId } });
    if (!i) throw notFound('Year-end item not found', 'item_not_found');
    if (i.status !== 'ACTIVE') throw conflict('This item is already cancelled', 'item_cancelled');
    const date = isoDay(i.itemDate), ids: string[] = [];
    if (i.accrualJournalId) {
      ids.push((await this.mirror(tx, a, { journalId: i.accrualJournalId, date, source: 'ACCRUAL_CANCELLATION', sourceId: i.id, ref: 'YE-CANCEL', label: i.description, reason: a.reason, key: `accrual-cancel:${i.id}` })).id);
      ids.push((await this.mirror(tx, a, { journalId: i.autoReversalJournalId!, date: addDays(date, 1), source: 'ACCRUAL_CANCELLATION', sourceId: i.id, ref: 'YE-CANCEL', label: `the reversal of ${i.description}`, reason: a.reason, key: `accrual-cancel-reversal:${i.id}` })).id);
    } else {
      if ((await this.released(tx, [i.id])).get(i.id)) throw conflict('Part of this schedule has been released; reverse the release runs first', 'item_released');
      if (i.setupKind === 'POSTED') ids.push((await this.mirror(tx, a, { journalId: i.setupJournalId!, date, source: 'ADJUSTMENT_SETUP_REVERSAL', sourceId: i.id, ref: 'YE-CANCEL', label: `the set-up of ${i.description}`, reason: a.reason, key: `adjustment-setup-reversal:${i.id}` })).id);
    }
    await tx.yearEndItem.update({ where: { id: i.id }, data: { status: 'CANCELLED', cancellationJournalIds: ids, cancelledByUserId: a.actor.userId!, cancelledAt: new Date(), cancelledReason: a.reason.trim() } });
    await this.audit(tx, { action: 'year_end.item_cancelled', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'year_end_item', entityId: i.id,
      before: { status: 'ACTIVE' }, after: { status: 'CANCELLED', journals: ids }, reason: a.reason });
    return this.getItem(tx, a.companyId, i.id);
  }

  // ───── Release runs ─────
  async preview(tx: Tx, companyId: string, asAt: string) {
    const minor = await this.minor(tx, companyId);
    const later = await tx.releaseRun.findFirst({ where: { companyId, status: 'POSTED', asAt: { gte: toDate(asAt) } }, orderBy: { asAt: 'desc' }, select: { asAt: true } });
    if (later) throw conflict(`A live release run as at ${isoDay(later.asAt)} exists; a new run must be later`, 'run_not_later');
    const items = await tx.yearEndItem.findMany({ where: { companyId, status: 'ACTIVE', kind: { in: SCHEDULES }, itemDate: { lte: toDate(asAt) } }, orderBy: [{ itemDate: 'asc' }, { createdAt: 'asc' }] });
    const rel = await this.released(tx, items.map((i) => i.id));
    const lines = items.map((i) => {
      const done = rel.get(i.id) ?? ZERO;
      const due = releaseDue({ amount: i.amount, periodStart: isoDay(i.periodStart!), periodEnd: isoDay(i.periodEnd!), convention: i.convention! }, asAt).toDecimalPlaces(minor, Prisma.Decimal.ROUND_HALF_UP);
      return { i, amount: due.minus(done), after: due };
    }).filter((l) => l.amount.greaterThan(0));
    // one pair of journal lines per (kind, P&L account, balance account), in a stable order
    const groups = new Map<string, { kind: string; pl: string; bal: string; amount: Money }>();
    for (const l of lines) {
      const k = `${l.i.kind}|${l.i.plAccountId}|${l.i.balanceAccountId}`;
      const g = groups.get(k) ?? { kind: l.i.kind, pl: l.i.plAccountId, bal: l.i.balanceAccountId, amount: ZERO };
      groups.set(k, { ...g, amount: g.amount.plus(l.amount) });
    }
    const total = lines.reduce((t, l) => t.plus(l.amount), ZERO);
    return { lines, groups: [...groups.values()], total, view: { companyId, asAt, total: fmt(total, minor),
      lines: lines.map((l) => ({ itemId: l.i.id, kind: l.i.kind, description: l.i.description, amount: fmt(l.amount, minor), releasedAfter: fmt(l.after, minor), unreleasedAfter: fmt(l.i.amount.minus(l.after), minor) })) } };
  }
  async previewView(tx: Tx, companyId: string, asAt: string) { return (await this.preview(tx, companyId, asAt)).view; }
  async postRun(tx: Tx, a: Ctx & { asAt: string }) {
    await this.need(a.actor, a.companyId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`release:${a.companyId}`}))`;
    const p = await this.preview(tx, a.companyId, a.asAt);
    if (p.total.isZero()) throw unprocessable('Nothing to release as at this date', 'nothing_to_release');
    const id = uuidv7();
    const j = await this.post(tx, a, { date: a.asAt, source: 'ADJUSTMENT_RELEASE', sourceId: id, ref: `REL-${a.asAt}`, description: `Release of prepayments and deferred income as at ${a.asAt}`, key: `release:${id}`,
      lines: p.groups.flatMap((g) => g.kind === 'PREPAYMENT' ? [L(g.pl, g.amount, ZERO, `Prepayment released as at ${a.asAt}`), L(g.bal, ZERO, g.amount, `Prepayment released as at ${a.asAt}`)]
        : [L(g.bal, g.amount, ZERO, `Deferred income released as at ${a.asAt}`), L(g.pl, ZERO, g.amount, `Deferred income released as at ${a.asAt}`)]) });
    try {
      await tx.releaseRun.create({ data: { id, organisationId: a.organisationId, companyId: a.companyId, asAt: toDate(a.asAt), journalId: j.id, total: p.total, createdByUserId: a.actor.userId! } });
    } catch (e) {
      if ((e instanceof Error && e.message.includes('later than every live run')) || (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw conflict('A release run as at this date or later exists', 'run_not_later');
      throw e;
    }
    await tx.releaseRunLine.createMany({ data: p.lines.map((l) => ({ organisationId: a.organisationId, runId: id, itemId: l.i.id, amount: l.amount, releasedAfter: l.after })) });
    await this.audit(tx, { action: 'year_end.release_posted', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'release_run', entityId: id,
      after: { asAt: a.asAt, total: p.total.toFixed(2), journalId: j.id, items: p.lines.length } });
    return this.getRun(tx, a.companyId, id);
  }
  async reverseRun(tx: Tx, a: Ctx & { id: string; reason: string }) {
    await this.need(a.actor, a.companyId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`release:${a.companyId}`}))`;
    const r = await tx.releaseRun.findFirst({ where: { id: a.id, companyId: a.companyId } });
    if (!r) throw notFound('Release run not found', 'run_not_found');
    if (r.status !== 'POSTED') throw conflict('This run is already reversed', 'run_reversed');
    const later = await tx.releaseRun.findFirst({ where: { companyId: a.companyId, status: 'POSTED', asAt: { gt: r.asAt } }, select: { asAt: true } });
    if (later) throw conflict(`Only the latest live run can be reversed; reverse the run as at ${isoDay(later.asAt)} first`, 'not_latest_run');
    const j = await this.mirror(tx, a, { journalId: r.journalId, date: isoDay(r.asAt), source: 'ADJUSTMENT_RELEASE_REVERSAL', sourceId: r.id, ref: `REL-${isoDay(r.asAt)}`, label: `the release as at ${isoDay(r.asAt)}`, reason: a.reason, key: `release-reversal:${r.id}` });
    await tx.releaseRun.update({ where: { id: r.id }, data: { status: 'REVERSED', reversalJournalId: j.id, reversedByUserId: a.actor.userId!, reversedAt: new Date(), reversedReason: a.reason.trim() } });
    await this.audit(tx, { action: 'year_end.release_reversed', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'release_run', entityId: r.id,
      before: { status: 'POSTED' }, after: { status: 'REVERSED', reversalJournalId: j.id }, reason: a.reason });
    return this.getRun(tx, a.companyId, r.id);
  }
  async getRun(tx: Tx, companyId: string, id: string) {
    const r = await tx.releaseRun.findFirst({ where: { id, companyId } });
    if (!r) throw notFound('Release run not found', 'run_not_found');
    const minor = await this.minor(tx, companyId);
    const lines = await tx.releaseRunLine.findMany({ where: { runId: id } });
    const items = new Map((await tx.yearEndItem.findMany({ where: { id: { in: lines.map((l) => l.itemId) } }, select: { id: true, description: true, kind: true } })).map((i) => [i.id, i]));
    return { ...this.runView(r, minor), lines: lines.map((l) => ({ itemId: l.itemId, kind: items.get(l.itemId)!.kind, description: items.get(l.itemId)!.description, amount: fmt(l.amount, minor), releasedAfter: fmt(l.releasedAfter, minor) })) };
  }
  private runView(r: Awaited<ReturnType<Tx['releaseRun']['findUniqueOrThrow']>>, minor: number) {
    return { id: r.id, companyId: r.companyId, asAt: isoDay(r.asAt), status: r.status, journalId: r.journalId, reversalJournalId: r.reversalJournalId, total: fmt(r.total, minor), createdByUserId: r.createdByUserId,
      createdAt: r.createdAt, reversedByUserId: r.reversedByUserId, reversedAt: r.reversedAt, reversedReason: r.reversedReason };
  }
  async listRuns(tx: Tx, companyId: string) {
    const minor = await this.minor(tx, companyId);
    return { items: (await tx.releaseRun.findMany({ where: { companyId }, orderBy: [{ asAt: 'asc' }, { createdAt: 'asc' }] })).map((r) => this.runView(r, minor)) };
  }

  // ───── Provisions (FRS 102 s.21) ─────
  async createProvision(tx: Tx, a: Ctx & { name: string; accountId: string; expenseAccountId: string; basis: string; evidenceDocumentIds: string[] }) {
    await this.need(a.actor, a.companyId);
    const acct = await this.account(tx, a.companyId, a.accountId, 'LIABILITY', 'provision account');
    const exp = await this.account(tx, a.companyId, a.expenseAccountId, 'EXPENSE', 'expense account');
    if (a.evidenceDocumentIds.length && (await tx.document.count({ where: { id: { in: a.evidenceDocumentIds }, companyId: a.companyId } })) !== a.evidenceDocumentIds.length) throw unprocessable('An evidence document does not belong to this company', 'unknown_document');
    const p = await tx.provision.create({ data: { organisationId: a.organisationId, companyId: a.companyId, name: a.name, accountId: acct.id, expenseAccountId: exp.id, basis: a.basis, evidenceDocumentIds: a.evidenceDocumentIds, createdByUserId: a.actor.userId! } });
    await this.audit(tx, { action: 'year_end.provision_created', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'provision', entityId: p.id, after: { name: p.name, accountId: acct.id, expenseAccountId: exp.id, basis: p.basis } });
    return this.getProvision(tx, a.companyId, p.id);
  }
  private movementView(m: MovementRow, minor: number) {
    return { id: m.id, provisionId: m.provisionId, kind: m.kind, date: isoDay(m.movementDate), amount: fmt(m.amount, minor), offsetAccountId: m.offsetAccountId, reason: m.reason, journalId: m.journalId, status: m.status,
      reversalJournalId: m.reversalJournalId, reversedByUserId: m.reversedByUserId, reversedAt: m.reversedAt, reversedReason: m.reversedReason, createdByUserId: m.createdByUserId, createdAt: m.createdAt };
  }
  private balance(ms: MovementRow[], upTo?: string) {
    return ms.filter((m) => m.status === 'POSTED' && (!upTo || isoDay(m.movementDate) <= upTo)).reduce((t, m) => (m.kind === 'MADE' ? t.plus(m.amount) : t.minus(m.amount)), ZERO);
  }
  async getProvision(tx: Tx, companyId: string, id: string) {
    const p = await tx.provision.findFirst({ where: { id, companyId } });
    if (!p) throw notFound('Provision not found', 'provision_not_found');
    const minor = await this.minor(tx, companyId);
    const ms = await tx.provisionMovement.findMany({ where: { provisionId: id }, orderBy: [{ movementDate: 'asc' }, { createdAt: 'asc' }] });
    return { id: p.id, companyId: p.companyId, name: p.name, accountId: p.accountId, expenseAccountId: p.expenseAccountId, basis: p.basis, evidenceDocumentIds: p.evidenceDocumentIds, createdByUserId: p.createdByUserId,
      createdAt: p.createdAt, balance: fmt(this.balance(ms), minor), movements: ms.map((m) => this.movementView(m, minor)) };
  }
  async listProvisions(tx: Tx, companyId: string) {
    const ps = await tx.provision.findMany({ where: { companyId }, orderBy: { createdAt: 'asc' } });
    return { items: await Promise.all(ps.map((p) => this.getProvision(tx, companyId, p.id))) };
  }
  async addMovement(tx: Tx, a: Ctx & { provisionId: string; kind: 'MADE' | 'USED' | 'RELEASED'; date: string; amount: string; offsetAccountId?: string; reason: string }) {
    await this.need(a.actor, a.companyId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`provision:${a.provisionId}`}))`;          // the runtime role holds no UPDATE on provision, so no row lock
    const p = await tx.provision.findFirst({ where: { id: a.provisionId, companyId: a.companyId } });
    if (!p) throw notFound('Provision not found', 'provision_not_found');
    const minor = await this.minor(tx, a.companyId);
    const amount = money(a.amount);
    if (amount.decimalPlaces() > minor) throw unprocessable(`Amounts have at most ${minor} decimal places`, 'invalid_amount');
    const ms = await tx.provisionMovement.findMany({ where: { provisionId: p.id, status: 'POSTED' } });
    const last = ms.map((m) => isoDay(m.movementDate)).sort().pop();
    if (last && a.date < last) throw unprocessable(`Movements are recorded in date order; the latest is dated ${last}`, 'invalid_date');
    const bal = this.balance(ms);
    if (a.kind !== 'MADE' && amount.greaterThan(bal)) throw unprocessable(`The provision stands at ${fmt(bal, minor)}; it cannot be ${a.kind === 'USED' ? 'used' : 'released'} by more`, 'provision_exceeded');
    let offset: string | null = null;
    if (a.kind === 'USED') {
      const o = await tx.account.findFirst({ where: { id: a.offsetAccountId!, companyId: a.companyId } });
      if (!o) throw unprocessable('The account does not exist in this company', 'unknown_account');
      if (o.isControl) throw unprocessable(`${o.code} is a control account, maintained by its own module`, 'control_account_restricted');
      if (o.id === p.accountId) throw unprocessable('A use is credited to the account the cost went to, not to the provision itself', 'invalid_offset_account');
      offset = o.id;
    }
    const id = uuidv7();
    const d = `${p.name}: ${a.reason.trim()}`;
    const lines = a.kind === 'MADE' ? [L(p.expenseAccountId, amount, ZERO, d), L(p.accountId, ZERO, amount, d)]
      : a.kind === 'USED' ? [L(p.accountId, amount, ZERO, d), L(offset!, ZERO, amount, d)] : [L(p.accountId, amount, ZERO, d), L(p.expenseAccountId, ZERO, amount, d)];
    const j = await this.post(tx, a, { date: a.date, source: 'PROVISION_MOVEMENT', sourceId: id, ref: `PROV-${a.kind}`, description: `Provision ${a.kind.toLowerCase()}: ${d}`, lines, key: `provision:${id}`, reason: a.reason });
    await tx.provisionMovement.create({ data: { id, organisationId: a.organisationId, companyId: a.companyId, provisionId: p.id, kind: a.kind, movementDate: toDate(a.date), amount, offsetAccountId: offset, reason: a.reason, journalId: j.id, createdByUserId: a.actor.userId! } });
    await this.audit(tx, { action: 'year_end.provision_movement', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'provision', entityId: p.id,
      after: { movementId: id, kind: a.kind, date: a.date, amount: fmt(amount, minor), journalId: j.id }, reason: a.reason });
    return this.getProvision(tx, a.companyId, p.id);
  }
  async reverseMovement(tx: Tx, a: Ctx & { id: string; reason: string }) {
    await this.need(a.actor, a.companyId);
    const m = await tx.provisionMovement.findFirst({ where: { id: a.id, companyId: a.companyId } });
    if (!m) throw notFound('Movement not found', 'movement_not_found');
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`provision:${m.provisionId}`}))`;
    if (m.status !== 'POSTED') throw conflict('This movement is already reversed', 'movement_reversed');
    const later = await tx.provisionMovement.findFirst({ where: { provisionId: m.provisionId, status: 'POSTED', id: { not: m.id }, OR: [{ movementDate: { gt: m.movementDate } }, { movementDate: m.movementDate, createdAt: { gt: m.createdAt } }] } });
    if (later) throw conflict('Only the latest live movement of a provision can be reversed', 'not_latest_movement');
    const j = await this.mirror(tx, a, { journalId: m.journalId, date: isoDay(m.movementDate), source: 'PROVISION_MOVEMENT_REVERSAL', sourceId: m.id, ref: `PROV-${m.kind}`, label: `a provision ${m.kind.toLowerCase()}`, reason: a.reason, key: `provision-reversal:${m.id}` });
    await tx.provisionMovement.update({ where: { id: m.id }, data: { status: 'REVERSED', reversalJournalId: j.id, reversedByUserId: a.actor.userId!, reversedAt: new Date(), reversedReason: a.reason.trim() } });
    await this.audit(tx, { action: 'year_end.provision_movement_reversed', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'provision', entityId: m.provisionId,
      before: { movementId: m.id, status: 'POSTED' }, after: { status: 'REVERSED', reversalJournalId: j.id }, reason: a.reason });
    return this.getProvision(tx, a.companyId, m.provisionId);
  }
  /** Opening, made, used, released and closing per provision for a date range (the FRS 102 s.21 reconciliation). */
  async provisionReport(tx: Tx, companyId: string, q: { from: string; to: string }) {
    const minor = await this.minor(tx, companyId);
    const ps = await tx.provision.findMany({ where: { companyId }, orderBy: { createdAt: 'asc' } });
    const f = (m: Money) => fmt(m, minor);
    const out = [];
    for (const p of ps) {
      const ms = (await tx.provisionMovement.findMany({ where: { provisionId: p.id, status: 'POSTED' } })).map((m) => ({ ...m, d: isoDay(m.movementDate) }));
      const sum = (k: string) => ms.filter((m) => m.kind === k && m.d >= q.from && m.d <= q.to).reduce((t, m) => t.plus(m.amount), ZERO);
      const opening = ms.filter((m) => m.d < q.from).reduce((t, m) => (m.kind === 'MADE' ? t.plus(m.amount) : t.minus(m.amount)), ZERO);
      const made = sum('MADE'), used = sum('USED'), released = sum('RELEASED');
      out.push({ provisionId: p.id, name: p.name, basis: p.basis, opening: f(opening), made: f(made), used: f(used), released: f(released), closing: f(opening.plus(made).minus(used).minus(released)) });
    }
    return { companyId, from: q.from, to: q.to, provisions: out };
  }

  // ───── Register and reconciliation ─────
  async register(tx: Tx, companyId: string, asAt: string) {
    const minor = await this.minor(tx, companyId);
    const f = (m: Money) => fmt(m, minor);
    const items = await tx.yearEndItem.findMany({ where: { companyId, status: 'ACTIVE', itemDate: { lte: toDate(asAt) } }, orderBy: [{ itemDate: 'asc' }, { createdAt: 'asc' }] });
    const rel = await this.released(tx, items.filter((i) => SCHEDULES.includes(i.kind)).map((i) => i.id), asAt);
    // an accrual stands on its own date only (it is reversed the next day); a schedule stands until fully released
    const rows = items.map((i) => ({ i, balance: SCHEDULES.includes(i.kind) ? i.amount.minus(rel.get(i.id) ?? ZERO) : isoDay(i.itemDate) === asAt ? i.amount : ZERO }));
    const provisions = await tx.provision.findMany({ where: { companyId } });
    const pms = await tx.provisionMovement.findMany({ where: { companyId, status: 'POSTED', movementDate: { lte: toDate(asAt) } } });
    const pb = provisions.map((p) => ({ p, balance: this.balance(pms.filter((m) => m.provisionId === p.id)) }));
    const accounts = new Map<string, Money>();
    for (const r of rows) accounts.set(r.i.balanceAccountId, (accounts.get(r.i.balanceAccountId) ?? ZERO).plus(r.balance));
    for (const r of pb) accounts.set(r.p.accountId, (accounts.get(r.p.accountId) ?? ZERO).plus(r.balance));
    const ids = [...accounts.keys()];
    const meta = new Map((await tx.account.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, type: true } })).map((a) => [a.id, a]));
    const ledger = ids.length === 0 ? [] : await tx.$queryRaw<{ account_id: string; journal_id: string; journal_number: number; journal_date: Date; source_type: string; description: string; net: string }[]>`
      SELECT l.account_id, j.id AS journal_id, j.journal_number, j.journal_date, j.source_type, j.description, sum(l.debit - l.credit)::text AS net
        FROM journal_line l JOIN journal j ON j.id = l.journal_id AND j.organisation_id = l.organisation_id
       WHERE l.company_id = ${companyId}::uuid AND l.account_id = ANY(${ids}::uuid[]) AND j.journal_date <= ${asAt}::date
       GROUP BY l.account_id, j.id, j.journal_number, j.journal_date, j.source_type, j.description ORDER BY j.journal_date, j.journal_number`;
    const linked = new Map<string, Money>();
    for (const r of rows) if (r.i.setupKind === 'LINKED') linked.set(`${r.i.setupJournalId}|${r.i.balanceAccountId}`, (linked.get(`${r.i.setupJournalId}|${r.i.balanceAccountId}`) ?? ZERO).plus(r.i.amount));
    const reconciliation = ids.map((id) => {
      const a = meta.get(id)!, sign = a.type === 'ASSET' ? 1 : -1;
      const ls = ledger.filter((l) => l.account_id === id);
      const led = ls.reduce((t, l) => t.plus(money(l.net)), ZERO).mul(sign);
      const items = ls.filter((l) => !YEAR_END_SOURCES.includes(l.source_type)).map((l) => {
        const amt = money(l.net).mul(sign), reg = linked.get(`${l.journal_id}|${id}`) ?? ZERO;
        return { journalId: l.journal_id, journalNumber: l.journal_number, journalDate: isoDay(l.journal_date), sourceType: l.source_type, description: l.description, amount: f(amt), registered: f(reg), unregistered: amt.minus(reg) };
      }).filter((x) => !x.unregistered.isZero()).map((x) => ({ ...x, unregistered: f(x.unregistered) }));
      const reg = accounts.get(id)!;
      return { accountId: id, code: a.code, register: f(reg), ledger: f(led), difference: f(reg.minus(led)), reconciled: reg.equals(led), items };
    }).sort((x, y) => (x.code < y.code ? -1 : 1));
    return { companyId, asAt,
      items: rows.map((r) => ({ id: r.i.id, kind: r.i.kind, description: r.i.description, amount: f(r.i.amount), balanceAccountId: r.i.balanceAccountId, balance: f(r.balance) })),
      provisions: pb.map((r) => ({ id: r.p.id, name: r.p.name, accountId: r.p.accountId, balance: f(r.balance) })),
      reconciliation, reconciled: reconciliation.every((r) => r.reconciled) };
  }
}
