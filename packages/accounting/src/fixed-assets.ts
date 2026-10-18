import { conflict, forbidden, notFound, unprocessable, uuidv7 } from '@uk/core';
import { Prisma, type Tx } from '@uk/db';
import { auditRow } from '@uk/platform';
import { accumulatedDue, addDays, type Basis, type Convention, type Method } from './depreciation-math';
import { ZERO, fmt, money, type Money } from './money';
import type { PostLineInput, PostingActor, PostingService } from './posting';

/**
 * V2-M2 fixed-asset register and depreciation (DEC-058; v2-plan section 4). The register holds classes, assets and their depreciation bases; every
 * ledger effect goes through the PostingService under a FIXED_ASSET_* journal source and is corrected by its own mirror, never edited. Tax
 * fields are stored for V4 and never read by depreciation (architecture-tested). The database repeats the rules (immutability, append-only bases,
 * one live run per date, reversal of the latest live run only).
 */
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
const FA_SOURCES = ['FIXED_ASSET_ADDITION', 'FIXED_ASSET_ADDITION_REVERSAL', 'FIXED_ASSET_DEPRECIATION', 'FIXED_ASSET_DEPRECIATION_REVERSAL', 'FIXED_ASSET_DISPOSAL', 'FIXED_ASSET_DISPOSAL_REVERSAL'];

type ClassRow = Awaited<ReturnType<Tx['fixedAssetClass']['findUniqueOrThrow']>>;
type AssetRow = Awaited<ReturnType<Tx['fixedAsset']['findUniqueOrThrow']>>;
type BasisRow = Awaited<ReturnType<Tx['fixedAssetBasis']['findUniqueOrThrow']>>;
type Ctx = { organisationId: string; companyId: string; actor: PostingActor };

const basisOf = (b: BasisRow): Basis => ({
  effectiveFrom: isoDay(b.effectiveFrom), carryingAmount: b.carryingAmount, accumulatedBefore: b.accumulatedBefore, method: b.method as Method,
  lifeMonths: b.lifeMonths, ratePercent: b.ratePercent, residual: b.residual, convention: b.convention as Convention,
});
const dbMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Shared reads: the minor units, an asset's bases, what has been charged to it, and when it was last charged. */
class AssetState {
  async minor(tx: Tx, companyId: string) {
    const c = await tx.company.findFirst({ where: { id: companyId }, select: { baseCurrency: true } });
    if (!c) throw notFound('Company not found');
    return { currency: c.baseCurrency, minor: (await tx.currency.findUnique({ where: { code: c.baseCurrency } }))?.minorUnits ?? 2 };
  }
  async bases(tx: Tx, assetId: string) { return tx.fixedAssetBasis.findMany({ where: { assetId }, orderBy: [{ effectiveFrom: 'asc' }, { createdAt: 'asc' }] }); }
  /** Live run lines of the assets (optionally only runs dated on or before a date). */
  async liveLines(tx: Tx, assetIds: string[], asAt?: string) {
    if (assetIds.length === 0) return [];
    return tx.$queryRaw<{ asset_id: string; amount: string; as_at: Date; run_id: string; created_at: Date }[]>`
      SELECT l.asset_id, l.amount::text AS amount, r.as_at, r.id AS run_id, r.created_at FROM depreciation_run_line l JOIN depreciation_run r ON r.id = l.run_id AND r.organisation_id = l.organisation_id
       WHERE l.asset_id = ANY(${assetIds}::uuid[]) AND r.status = 'POSTED' ${asAt ? Prisma.sql`AND r.as_at <= ${asAt}::date` : Prisma.empty}`;
  }
  /** Accumulated depreciation on the asset now: take-on + live runs + a disposal catch-up while disposed. */
  charged(a: AssetRow, lines: { asset_id: string; amount: string }[]) {
    return lines.filter((l) => l.asset_id === a.id).reduce((t, l) => t.plus(money(l.amount)), a.takeOnAccumulated).plus(a.status === 'DISPOSED' ? (a.disposalCatchUp ?? ZERO) : ZERO);
  }
  lastCharged(a: AssetRow, lines: { asset_id: string; as_at: Date }[]) {
    const ds = lines.filter((l) => l.asset_id === a.id).map((l) => isoDay(l.as_at)).sort();
    return ds.length ? ds[ds.length - 1]! : null;
  }
}

export class FixedAssetService {
  private readonly state = new AssetState();
  constructor(private readonly posting: PostingService, private readonly opts: { captureDeviceMetadata?: boolean } = {}) {}
  private audit(tx: Tx, e: Parameters<typeof auditRow>[0]) { return tx.auditEvent.createMany({ data: [auditRow(e, this.opts.captureDeviceMetadata)] }); }
  private async need(actor: PostingActor, companyId: string) {
    if (actor.kind !== 'USER') throw forbidden('Only a person can change the fixed-asset register', 'ai_cannot_post');
    if (!(await actor.can('assets:manage', companyId))) throw forbidden('Requires permission assets:manage', 'permission_denied');
  }
  private async account(tx: Tx, companyId: string, id: string, date: string, what: string) {
    const a = await tx.account.findFirst({ where: { id, companyId } });
    if (!a) throw unprocessable(`The ${what} does not exist in this company`, 'unknown_account');
    if (a.isControl) throw unprocessable(`The ${what} ${a.code} is a control account, maintained by its own module`, 'control_account_restricted');
    if ((a.activeFrom && date < isoDay(a.activeFrom)) || (a.activeTo && date > isoDay(a.activeTo))) throw unprocessable(`Account ${a.code} is not active on ${date}`, 'account_inactive');
    return a;
  }

  // ───── Classes ─────
  private classView(c: ClassRow) {
    return { id: c.id, companyId: c.companyId, code: c.code, name: c.name, costAccountId: c.costAccountId, depreciationAccountId: c.depreciationAccountId, expenseAccountId: c.expenseAccountId,
      disposalAccountId: c.disposalAccountId, method: c.method, lifeMonths: c.lifeMonths, ratePercent: c.ratePercent ? c.ratePercent.toString() : null, residualPercent: c.residualPercent.toString(),
      convention: c.convention, createdByUserId: c.createdByUserId, createdAt: c.createdAt, updatedAt: c.updatedAt };
  }
  async listClasses(tx: Tx, companyId: string) { return { items: (await tx.fixedAssetClass.findMany({ where: { companyId }, orderBy: { code: 'asc' } })).map((c) => this.classView(c)) }; }
  async createClass(tx: Tx, a: Ctx & { code: string; name: string; costAccountId: string; depreciationAccountId: string; expenseAccountId: string; disposalAccountId: string; method: Method; lifeMonths?: number; ratePercent?: string; residualPercent: string; convention: Convention }) {
    await this.need(a.actor, a.companyId);
    let c: ClassRow;
    try {
      c = await tx.fixedAssetClass.create({ data: { organisationId: a.organisationId, companyId: a.companyId, code: a.code, name: a.name, costAccountId: a.costAccountId, depreciationAccountId: a.depreciationAccountId,
        expenseAccountId: a.expenseAccountId, disposalAccountId: a.disposalAccountId, method: a.method, lifeMonths: a.lifeMonths ?? null, ratePercent: a.ratePercent ?? null, residualPercent: a.residualPercent,
        convention: a.convention, createdByUserId: a.actor.userId! } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict(`Class ${a.code} already exists`, 'class_exists');
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003') throw unprocessable('An account does not exist in this company', 'unknown_account');
      const m = dbMessage(e);
      const hit = /(cost account must[^;"]*|depreciation account must[^;"]*|expense account must[^;"]*|disposal account must[^;"]*|a fixed-asset class cannot use a control account)/.exec(m);
      if (hit) throw unprocessable(hit[1]!.replace(/\s+$/, ''), 'invalid_class_account');
      if (m.includes('fac_accounts_ck')) throw unprocessable('A class needs four different accounts', 'invalid_class_account');
      throw e;
    }
    await this.audit(tx, { action: 'assets.class_created', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'fixed_asset_class', entityId: c.id, after: this.classView(c) });
    return this.classView(c);
  }
  async updateClass(tx: Tx, a: Ctx & { id: string; name?: string; method?: Method; lifeMonths?: number; ratePercent?: string; residualPercent?: string; convention?: Convention; reason: string }) {
    await this.need(a.actor, a.companyId);
    const before = await tx.fixedAssetClass.findFirst({ where: { id: a.id, companyId: a.companyId } });
    if (!before) throw notFound('Class not found', 'class_not_found');
    const method = a.method ?? (before.method as Method);
    const methodData = a.method ? { method, lifeMonths: a.lifeMonths ?? null, ratePercent: a.ratePercent ?? null }
      : method === 'STRAIGHT_LINE' ? (a.ratePercent !== undefined ? null : { lifeMonths: a.lifeMonths ?? before.lifeMonths }) : (a.lifeMonths !== undefined ? null : { ratePercent: a.ratePercent ?? before.ratePercent });
    if (!methodData) throw unprocessable('Straight line takes lifeMonths, reducing balance takes ratePercent', 'invalid_method');
    const after = await tx.fixedAssetClass.update({ where: { id: a.id }, data: { ...(a.name ? { name: a.name } : {}), ...methodData, ...(a.residualPercent !== undefined ? { residualPercent: a.residualPercent } : {}), ...(a.convention ? { convention: a.convention } : {}) } });
    await this.audit(tx, { action: 'assets.class_changed', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'fixed_asset_class', entityId: a.id,
      before: this.classView(before), after: this.classView(after), reason: a.reason });
    return this.classView(after);
  }

  // ───── Assets ─────
  private async klass(tx: Tx, companyId: string, id: string) {
    const c = await tx.fixedAssetClass.findFirst({ where: { id, companyId } });
    if (!c) throw unprocessable('The class does not exist in this company', 'class_not_found');
    return c;
  }
  /** The net debit a journal put on an account, less the cost of the assets already linked to it. */
  private async linkable(tx: Tx, companyId: string, journalId: string, costAccountId: string) {
    const j = await tx.journal.findFirst({ where: { id: journalId, companyId } });
    if (!j) throw unprocessable('The journal does not exist in this company', 'unknown_journal');
    if (FA_SOURCES.includes(j.sourceType)) throw unprocessable('A journal posted by the register cannot be linked again', 'journal_not_linkable');
    if (await tx.journal.findFirst({ where: { reversesJournalId: j.id }, select: { id: true } })) throw unprocessable('The journal has been reversed', 'journal_not_linkable');
    const lines = await tx.journalLine.findMany({ where: { journalId: j.id, accountId: costAccountId }, select: { debit: true, credit: true } });
    const net = lines.reduce((t, l) => t.plus(l.debit).minus(l.credit), ZERO);
    const used = (await tx.fixedAsset.findMany({ where: { additionJournalId: j.id, status: { not: 'VOID' }, additionKind: { in: ['LINKED', 'TAKE_ON'] } }, select: { cost: true } })).reduce((t, x) => t.plus(x.cost), ZERO);
    return { journal: j, available: net.minus(used) };
  }
  async addAsset(tx: Tx, a: Ctx & { classId: string; description: string; acquiredOn: string; inUseFrom?: string; cost: string;
    addition: { kind: 'POSTED'; offsetAccountId: string } | { kind: 'LINKED'; journalId: string } | { kind: 'TAKE_ON'; takeOnDate: string; accumulatedDepreciation: string; journalId?: string };
    method?: Method; lifeMonths?: number; ratePercent?: string; residual?: string; convention?: Convention; tax: { category: string; cost?: string | null } }) {
    await this.need(a.actor, a.companyId);
    const c = await this.klass(tx, a.companyId, a.classId);
    const { minor } = await this.state.minor(tx, a.companyId);
    const cost = money(a.cost);
    if (cost.decimalPlaces() > minor) throw unprocessable(`Amounts have at most ${minor} decimal places`, 'invalid_amount');
    const inUseFrom = a.inUseFrom ?? a.acquiredOn;
    // depreciation parameters: the asset's own, else the class defaults
    const method = a.method ?? (c.method as Method);
    const lifeMonths = method === 'STRAIGHT_LINE' ? (a.lifeMonths ?? (a.method ? undefined : c.lifeMonths ?? undefined)) : undefined;
    const ratePercent = method === 'REDUCING_BALANCE' ? (a.ratePercent ? money(a.ratePercent) : a.method ? undefined : c.ratePercent ?? undefined) : undefined;
    if (method === 'STRAIGHT_LINE' && !lifeMonths) throw unprocessable('Straight line needs lifeMonths', 'invalid_method');
    if (method === 'REDUCING_BALANCE' && !ratePercent) throw unprocessable('Reducing balance needs ratePercent', 'invalid_method');
    if (a.addition.kind === 'TAKE_ON' && method === 'STRAIGHT_LINE' && a.lifeMonths === undefined) throw unprocessable('A taken-on asset gives the life remaining after the take-on date (lifeMonths)', 'remaining_life_required');
    const residual = a.residual !== undefined ? money(a.residual) : cost.mul(c.residualPercent).div(100).toDecimalPlaces(minor, Prisma.Decimal.ROUND_HALF_UP);
    const takeOnAcc = a.addition.kind === 'TAKE_ON' ? money(a.addition.accumulatedDepreciation) : ZERO;
    if (a.addition.kind === 'TAKE_ON' && (a.addition.takeOnDate < inUseFrom)) throw unprocessable('The take-on date cannot precede the date the asset came into use', 'invalid_date');
    if (takeOnAcc.greaterThanOrEqualTo(cost)) throw unprocessable('Accumulated depreciation at take-on must be below the cost', 'invalid_amount');
    if (residual.greaterThan(cost.minus(takeOnAcc))) throw unprocessable('The residual value cannot exceed the carrying amount', 'invalid_amount');
    const id = uuidv7();
    let additionJournalId: string | null = null, offsetAccountId: string | null = null;
    if (a.addition.kind === 'POSTED') {
      const off = await this.account(tx, a.companyId, a.addition.offsetAccountId, a.acquiredOn, 'offset account');
      if ([c.costAccountId, c.depreciationAccountId].includes(off.id)) throw unprocessable('The offset account cannot be one of the class accounts', 'invalid_offset_account');
      const j = await this.posting.post(tx, { organisationId: a.organisationId, companyId: a.companyId, journalDate: a.acquiredOn, sourceType: 'FIXED_ASSET_ADDITION', sourceId: id, sourceReference: `FA-ADD`,
        description: `Fixed asset added: ${a.description}`.slice(0, 500), idempotencyKey: `asset-addition:${id}`, actor: a.actor,
        lines: [{ accountId: c.costAccountId, debit: cost.toFixed(4), credit: '0', description: a.description.slice(0, 300) }, { accountId: off.id, debit: '0', credit: cost.toFixed(4), description: a.description.slice(0, 300) }] });
      additionJournalId = j.id; offsetAccountId = off.id;
    } else if (a.addition.journalId) {
      const { available } = await this.linkable(tx, a.companyId, a.addition.journalId, c.costAccountId);
      if (available.lessThan(cost)) throw unprocessable(`The journal debits the class's cost account by ${fmt(available, minor)} not yet registered, less than the cost ${fmt(cost, minor)}`, 'link_amount_exceeded');
      additionJournalId = a.addition.journalId;
    } else if (a.addition.kind === 'LINKED') throw unprocessable('A linked addition names its journal', 'unknown_journal');
    const number = ((await tx.fixedAsset.aggregate({ where: { companyId: a.companyId }, _max: { number: true } }))._max.number ?? 0) + 1;
    let asset: AssetRow;
    try {
      asset = await tx.fixedAsset.create({ data: { id, organisationId: a.organisationId, companyId: a.companyId, classId: c.id, number, description: a.description, acquiredOn: toDate(a.acquiredOn), inUseFrom: toDate(inUseFrom),
        cost, additionKind: a.addition.kind, additionJournalId, offsetAccountId, takeOnDate: a.addition.kind === 'TAKE_ON' ? toDate(a.addition.takeOnDate) : null, takeOnAccumulated: takeOnAcc,
        taxCategory: a.tax.category, taxCost: a.tax.cost ?? null, createdByUserId: a.actor.userId! } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('Another asset was added at the same moment; try again', 'asset_number_taken');
      throw e;
    }
    const basisFrom = a.addition.kind === 'TAKE_ON' ? addDays(a.addition.takeOnDate, 1) : inUseFrom;
    await tx.fixedAssetBasis.create({ data: { organisationId: a.organisationId, assetId: id, effectiveFrom: toDate(basisFrom), carryingAmount: cost.minus(takeOnAcc), accumulatedBefore: takeOnAcc, method,
      lifeMonths: lifeMonths ?? null, ratePercent: ratePercent ?? null, residual, convention: a.convention ?? (c.convention as Convention), reason: a.addition.kind === 'TAKE_ON' ? 'Taken on' : 'Added', createdByUserId: a.actor.userId! } });
    await this.audit(tx, { action: 'assets.asset_added', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'fixed_asset', entityId: id,
      after: { number, classId: c.id, cost: fmt(cost, minor), kind: a.addition.kind, additionJournalId, method, lifeMonths: lifeMonths ?? null, ratePercent: ratePercent?.toString() ?? null, residual: fmt(residual, minor) } });
    return this.get(tx, a.companyId, id);
  }

  async get(tx: Tx, companyId: string, id: string) {
    const a = await tx.fixedAsset.findFirst({ where: { id, companyId } });
    if (!a) throw notFound('Asset not found', 'asset_not_found');
    const { minor } = await this.state.minor(tx, companyId);
    const [bases, lines, klass] = await Promise.all([this.state.bases(tx, id), this.state.liveLines(tx, [id]), tx.fixedAssetClass.findFirstOrThrow({ where: { id: a.classId } })]);
    const charged = this.state.charged(a, lines);
    const f = (m: Money | null) => (m === null ? null : fmt(m, minor));
    return { ...this.view(a, minor), classCode: klass.code, accumulatedDepreciation: f(a.status === 'DISPOSED' ? a.disposalAccumulated : charged)!,
      carryingAmount: f(a.status === 'VOID' ? ZERO : a.cost.minus(a.status === 'DISPOSED' ? a.disposalAccumulated! : charged))!, lastChargedOn: this.state.lastCharged(a, lines),
      bases: bases.map((b) => ({ id: b.id, effectiveFrom: isoDay(b.effectiveFrom), carryingAmount: f(b.carryingAmount)!, accumulatedBefore: f(b.accumulatedBefore)!, method: b.method, lifeMonths: b.lifeMonths,
        ratePercent: b.ratePercent?.toString() ?? null, residual: f(b.residual)!, convention: b.convention, reason: b.reason, createdByUserId: b.createdByUserId, createdAt: b.createdAt })),
      charges: lines.sort((x, y) => (x.as_at < y.as_at ? -1 : 1)).map((l) => ({ runId: l.run_id, asAt: isoDay(l.as_at), amount: fmt(money(l.amount), minor) })) };
  }
  private view(a: AssetRow, minor: number) {
    const f = (m: Money | null) => (m === null ? null : fmt(m, minor));
    return { id: a.id, companyId: a.companyId, classId: a.classId, number: a.number, description: a.description, acquiredOn: isoDay(a.acquiredOn), inUseFrom: isoDay(a.inUseFrom), cost: fmt(a.cost, minor),
      additionKind: a.additionKind, additionJournalId: a.additionJournalId, offsetAccountId: a.offsetAccountId, takeOnDate: a.takeOnDate ? isoDay(a.takeOnDate) : null, takeOnAccumulated: fmt(a.takeOnAccumulated, minor),
      status: a.status, additionReversalJournalId: a.additionReversalJournalId, disposedOn: a.disposedOn ? isoDay(a.disposedOn) : null, proceeds: f(a.proceeds), proceedsAccountId: a.proceedsAccountId,
      disposalJournalId: a.disposalJournalId, disposalCatchUp: f(a.disposalCatchUp), gainOrLoss: f(a.gainOrLoss), tax: { category: a.taxCategory, cost: f(a.taxCost) }, createdByUserId: a.createdByUserId, createdAt: a.createdAt };
  }
  async list(tx: Tx, companyId: string, q: { status?: string; classId?: string }) {
    const { minor } = await this.state.minor(tx, companyId);
    const rows = await tx.fixedAsset.findMany({ where: { companyId, ...(q.status ? { status: q.status } : {}), ...(q.classId ? { classId: q.classId } : {}) }, orderBy: { number: 'asc' } });
    return { items: rows.map((a) => this.view(a, minor)) };
  }

  /** A prospective change of estimate (DEC-058): a new basis from the day after the last charge, at the carrying amount then. */
  async changeEstimate(tx: Tx, a: Ctx & { id: string; method?: Method; lifeMonths?: number; ratePercent?: string; residual?: string; convention?: Convention; reason: string }) {
    await this.need(a.actor, a.companyId);
    const asset = await tx.fixedAsset.findFirst({ where: { id: a.id, companyId: a.companyId } });
    if (!asset) throw notFound('Asset not found', 'asset_not_found');
    if (asset.status !== 'ACTIVE') throw conflict(`A ${asset.status.toLowerCase()} asset is not depreciated`, 'asset_not_active');
    const { minor } = await this.state.minor(tx, a.companyId);
    const [bases, lines] = await Promise.all([this.state.bases(tx, asset.id), this.state.liveLines(tx, [asset.id])]);
    const current = bases[bases.length - 1]!;
    const last = this.state.lastCharged(asset, lines);
    const from = last && addDays(last, 1) > isoDay(current.effectiveFrom) ? addDays(last, 1) : isoDay(current.effectiveFrom);
    const charged = this.state.charged(asset, lines), carrying = asset.cost.minus(charged);
    const method = a.method ?? (current.method as Method);
    const lifeMonths = method === 'STRAIGHT_LINE' ? (a.lifeMonths ?? (a.method && a.method !== current.method ? undefined : current.lifeMonths ?? undefined)) : undefined;
    const ratePercent = method === 'REDUCING_BALANCE' ? (a.ratePercent ? money(a.ratePercent) : a.method && a.method !== current.method ? undefined : current.ratePercent ?? undefined) : undefined;
    if (method === 'STRAIGHT_LINE' && !lifeMonths) throw unprocessable('Straight line needs the remaining life (lifeMonths)', 'invalid_method');
    if (method === 'REDUCING_BALANCE' && !ratePercent) throw unprocessable('Reducing balance needs ratePercent', 'invalid_method');
    const residual = a.residual !== undefined ? money(a.residual) : current.residual;
    if (residual.greaterThan(carrying)) throw unprocessable(`The residual value cannot exceed the carrying amount of ${fmt(carrying, minor)}`, 'invalid_amount');
    const b = await tx.fixedAssetBasis.create({ data: { organisationId: a.organisationId, assetId: asset.id, effectiveFrom: toDate(from), carryingAmount: carrying, accumulatedBefore: charged, method,
      lifeMonths: lifeMonths ?? null, ratePercent: ratePercent ?? null, residual, convention: a.convention ?? (current.convention as Convention), reason: a.reason, createdByUserId: a.actor.userId! } });
    await this.audit(tx, { action: 'assets.estimate_changed', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'fixed_asset', entityId: asset.id,
      before: { method: current.method, lifeMonths: current.lifeMonths, ratePercent: current.ratePercent?.toString() ?? null, residual: fmt(current.residual, minor), convention: current.convention },
      after: { effectiveFrom: from, carryingAmount: fmt(carrying, minor), method, lifeMonths: b.lifeMonths, ratePercent: b.ratePercent?.toString() ?? null, residual: fmt(residual, minor), convention: b.convention }, reason: a.reason });
    return this.get(tx, a.companyId, asset.id);
  }
  /** Tax fields are kept apart for V4 (DEC-058): changing them changes no depreciation figure. */
  async changeTax(tx: Tx, a: Ctx & { id: string; category: string; cost?: string | null; reason: string }) {
    await this.need(a.actor, a.companyId);
    const before = await tx.fixedAsset.findFirst({ where: { id: a.id, companyId: a.companyId } });
    if (!before) throw notFound('Asset not found', 'asset_not_found');
    const after = await tx.fixedAsset.update({ where: { id: a.id }, data: { taxCategory: a.category, ...(a.cost !== undefined ? { taxCost: a.cost } : {}) } });
    await this.audit(tx, { action: 'assets.tax_changed', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'fixed_asset', entityId: a.id,
      before: { category: before.taxCategory, cost: before.taxCost?.toString() ?? null }, after: { category: after.taxCategory, cost: after.taxCost?.toString() ?? null }, reason: a.reason });
    return this.get(tx, a.companyId, a.id);
  }

  // ───── Disposals ─────
  async dispose(tx: Tx, a: Ctx & { id: string; disposedOn: string; proceeds: string; proceedsAccountId?: string; reason: string }) {
    await this.need(a.actor, a.companyId);
    await tx.$queryRaw`SELECT id FROM fixed_asset WHERE id = ${a.id}::uuid FOR UPDATE`;
    const asset = await tx.fixedAsset.findFirst({ where: { id: a.id, companyId: a.companyId } });
    if (!asset) throw notFound('Asset not found', 'asset_not_found');
    if (asset.status !== 'ACTIVE') throw conflict(`A ${asset.status.toLowerCase()} asset cannot be disposed of`, 'asset_not_active');
    if (a.disposedOn < isoDay(asset.inUseFrom) || (asset.takeOnDate && a.disposedOn <= isoDay(asset.takeOnDate))) throw unprocessable('The disposal date precedes the asset\'s use or its take-on', 'invalid_date');
    const later = await tx.depreciationRun.findFirst({ where: { companyId: a.companyId, status: 'POSTED', asAt: { gt: toDate(a.disposedOn) } }, select: { asAt: true } });
    if (later) throw conflict(`A live depreciation run as at ${isoDay(later.asAt)} is later than the disposal; reverse it first`, 'later_run_exists');
    const c = await tx.fixedAssetClass.findFirstOrThrow({ where: { id: asset.classId } });
    const { minor } = await this.state.minor(tx, a.companyId);
    const proceeds = money(a.proceeds);
    if (proceeds.decimalPlaces() > minor) throw unprocessable(`Amounts have at most ${minor} decimal places`, 'invalid_amount');
    const proceedsAccount = a.proceedsAccountId ? await this.account(tx, a.companyId, a.proceedsAccountId, a.disposedOn, 'proceeds account') : null;
    if (proceedsAccount && [c.costAccountId, c.depreciationAccountId, c.disposalAccountId].includes(proceedsAccount.id)) throw unprocessable('The proceeds account cannot be one of the class accounts', 'invalid_proceeds_account');
    const [bases, lines] = await Promise.all([this.state.bases(tx, asset.id), this.state.liveLines(tx, [asset.id])]);
    const charged = this.state.charged(asset, lines);
    const due = accumulatedDue(basisOf(bases[bases.length - 1]!), a.disposedOn, minor, { disposal: true });
    const catchUp = Prisma.Decimal.max(ZERO, due.minus(charged));
    const accumulated = charged.plus(catchUp), carrying = asset.cost.minus(accumulated), gain = proceeds.minus(carrying);
    const L = (accountId: string, debit: Money, credit: Money, description: string): PostLineInput => ({ accountId, debit: debit.toFixed(4), credit: credit.toFixed(4), description });
    const d = `Disposal of asset ${asset.number} ${asset.description}`.slice(0, 300);
    const postLines = [
      ...(catchUp.isZero() ? [] : [L(c.expenseAccountId, catchUp, ZERO, `Depreciation to disposal: asset ${asset.number}`), L(c.depreciationAccountId, ZERO, catchUp, `Depreciation to disposal: asset ${asset.number}`)]),
      ...(accumulated.isZero() ? [] : [L(c.depreciationAccountId, accumulated, ZERO, d)]),
      ...(carrying.isZero() ? [] : [L(c.disposalAccountId, carrying, ZERO, `${d}: carrying amount`)]),
      L(c.costAccountId, ZERO, asset.cost, d),
      ...(proceedsAccount ? [L(proceedsAccount.id, proceeds, ZERO, `${d}: proceeds`), L(c.disposalAccountId, ZERO, proceeds, `${d}: proceeds`)] : []),
    ];
    const j = await this.posting.post(tx, { organisationId: a.organisationId, companyId: a.companyId, journalDate: a.disposedOn, sourceType: 'FIXED_ASSET_DISPOSAL', sourceId: asset.id, sourceReference: `FA-${asset.number}`,
      description: `${d}: ${a.reason.trim()}`.slice(0, 500), lines: postLines, idempotencyKey: `asset-disposal:${asset.id}:${uuidv7()}`, actor: a.actor, reason: a.reason });
    await tx.fixedAsset.update({ where: { id: asset.id }, data: { status: 'DISPOSED', disposedOn: toDate(a.disposedOn), proceeds, proceedsAccountId: proceedsAccount?.id ?? null, disposalJournalId: j.id,
      disposalCatchUp: catchUp, disposalAccumulated: accumulated, gainOrLoss: gain } });
    await this.audit(tx, { action: 'assets.asset_disposed', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'fixed_asset', entityId: asset.id,
      before: { status: 'ACTIVE' }, after: { status: 'DISPOSED', disposedOn: a.disposedOn, proceeds: fmt(proceeds, minor), catchUp: fmt(catchUp, minor), carrying: fmt(carrying, minor), gainOrLoss: fmt(gain, minor), journalId: j.id }, reason: a.reason });
    return this.get(tx, a.companyId, asset.id);
  }
  private async mirror(tx: Tx, a: Ctx & { journalId: string; date: string; sourceType: string; sourceId: string; reason: string; key: string; label: string }) {
    const lines = await tx.journalLine.findMany({ where: { journalId: a.journalId }, orderBy: { lineNo: 'asc' } });
    return this.posting.post(tx, { organisationId: a.organisationId, companyId: a.companyId, journalDate: a.date, sourceType: a.sourceType, sourceId: a.sourceId, sourceReference: null,
      description: `Reversal of ${a.label}: ${a.reason.trim()}`.slice(0, 500), idempotencyKey: a.key, actor: a.actor, reason: a.reason,
      lines: lines.map((l): PostLineInput => ({ accountId: l.accountId, debit: l.credit.toFixed(4), credit: l.debit.toFixed(4), description: (l.description ?? 'Reversed').slice(0, 300) })) });
  }
  async reverseDisposal(tx: Tx, a: Ctx & { id: string; reason: string }) {
    await this.need(a.actor, a.companyId);
    await tx.$queryRaw`SELECT id FROM fixed_asset WHERE id = ${a.id}::uuid FOR UPDATE`;
    const asset = await tx.fixedAsset.findFirst({ where: { id: a.id, companyId: a.companyId } });
    if (!asset) throw notFound('Asset not found', 'asset_not_found');
    if (asset.status !== 'DISPOSED') throw conflict('The asset is not disposed of', 'asset_not_disposed');
    const dj = await tx.journal.findFirstOrThrow({ where: { id: asset.disposalJournalId! } });
    const after = await tx.depreciationRun.findFirst({ where: { companyId: a.companyId, status: 'POSTED', asAt: { gte: asset.disposedOn! }, createdAt: { gt: dj.postedAt } }, select: { asAt: true } });
    if (after) throw conflict(`A live depreciation run as at ${isoDay(after.asAt)} was posted after the disposal; reverse it first`, 'later_run_exists');
    const j = await this.mirror(tx, { ...a, journalId: dj.id, date: isoDay(asset.disposedOn!), sourceType: 'FIXED_ASSET_DISPOSAL_REVERSAL', sourceId: asset.id, key: `asset-disposal-reversal:${dj.id}`, label: `disposal of asset ${asset.number}` });
    await tx.fixedAsset.update({ where: { id: asset.id }, data: { status: 'ACTIVE', disposedOn: null, proceeds: null, proceedsAccountId: null, disposalJournalId: null, disposalCatchUp: null, disposalAccumulated: null, gainOrLoss: null } });
    await this.audit(tx, { action: 'assets.disposal_reversed', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'fixed_asset', entityId: asset.id,
      before: { status: 'DISPOSED', disposalJournalId: dj.id }, after: { status: 'ACTIVE', reversalJournalId: j.id }, reason: a.reason });
    return this.get(tx, a.companyId, asset.id);
  }
  /** A POSTED addition is reversed by its mirror before any depreciation; the asset becomes VOID. A linked or taken-on asset posted nothing to reverse. */
  async reverseAddition(tx: Tx, a: Ctx & { id: string; reason: string }) {
    await this.need(a.actor, a.companyId);
    await tx.$queryRaw`SELECT id FROM fixed_asset WHERE id = ${a.id}::uuid FOR UPDATE`;
    const asset = await tx.fixedAsset.findFirst({ where: { id: a.id, companyId: a.companyId } });
    if (!asset) throw notFound('Asset not found', 'asset_not_found');
    if (asset.additionKind !== 'POSTED') throw conflict('Only an addition the register posted is reversed; a linked or taken-on asset is corrected where its posting came from', 'addition_not_posted');
    if (asset.status !== 'ACTIVE') throw conflict(`A ${asset.status.toLowerCase()} asset cannot be reversed`, 'asset_not_active');
    if ((await this.state.liveLines(tx, [asset.id])).length) throw conflict('The asset has been depreciated; reverse its runs first, or dispose of it', 'asset_depreciated');
    const j = await this.mirror(tx, { ...a, journalId: asset.additionJournalId!, date: isoDay(asset.acquiredOn), sourceType: 'FIXED_ASSET_ADDITION_REVERSAL', sourceId: asset.id, key: `asset-addition-reversal:${asset.id}`, label: `addition of asset ${asset.number}` });
    await tx.fixedAsset.update({ where: { id: asset.id }, data: { status: 'VOID', additionReversalJournalId: j.id } });
    await this.audit(tx, { action: 'assets.addition_reversed', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'fixed_asset', entityId: asset.id,
      before: { status: 'ACTIVE' }, after: { status: 'VOID', reversalJournalId: j.id }, reason: a.reason });
    return this.get(tx, a.companyId, asset.id);
  }

  // ───── Register and reconciliation (DEC-058) ─────
  async register(tx: Tx, companyId: string, asAt: string) {
    const { minor, currency } = await this.state.minor(tx, companyId);
    const f = (m: Money) => fmt(m, minor);
    const classes = await tx.fixedAssetClass.findMany({ where: { companyId }, orderBy: { code: 'asc' } });
    const all = await tx.fixedAsset.findMany({ where: { companyId, status: { not: 'VOID' } }, orderBy: { number: 'asc' } });
    // an asset is in the register from its acquisition (a taken-on asset from its take-on date)
    const assets = all.filter((a) => (a.takeOnDate ? isoDay(a.takeOnDate) : isoDay(a.acquiredOn)) <= asAt);
    const lines = await this.state.liveLines(tx, assets.map((a) => a.id), asAt);
    const rows = assets.map((a) => {
      const disposed = a.status === 'DISPOSED' && isoDay(a.disposedOn!) <= asAt;
      const runs = lines.filter((l) => l.asset_id === a.id).reduce((t, l) => t.plus(money(l.amount)), ZERO);
      const acc = disposed ? a.disposalAccumulated! : a.takeOnAccumulated.plus(runs);
      return { a, disposed, acc };
    });
    const out = classes.map((c) => {
      const rs = rows.filter((r) => r.a.classId === c.id);
      const live = rs.filter((r) => !r.disposed);
      const cost = live.reduce((t, r) => t.plus(r.a.cost), ZERO), acc = live.reduce((t, r) => t.plus(r.acc), ZERO);
      return { classId: c.id, code: c.code, name: c.name, cost: f(cost), accumulatedDepreciation: f(acc), carryingAmount: f(cost.minus(acc)),
        assets: rs.map((r) => ({ id: r.a.id, number: r.a.number, description: r.a.description, status: r.disposed ? 'DISPOSED' : 'ACTIVE', acquiredOn: isoDay(r.a.acquiredOn), cost: f(r.a.cost),
          accumulatedDepreciation: f(r.acc), carryingAmount: f(r.a.cost.minus(r.acc)), ...(r.disposed ? { disposedOn: isoDay(r.a.disposedOn!), proceeds: f(r.a.proceeds!), gainOrLoss: f(r.a.gainOrLoss!) } : {}) })) };
    });
    // reconciliation per account: what the register says against what the ledger holds
    const accounts = new Map<string, { kind: 'COST' | 'DEPRECIATION'; register: Money }>();
    for (const c of classes) {
      for (const [id, kind] of [[c.costAccountId, 'COST'], [c.depreciationAccountId, 'DEPRECIATION']] as const) if (!accounts.has(id)) accounts.set(id, { kind, register: ZERO });
      const live = rows.filter((r) => r.a.classId === c.id && !r.disposed);
      accounts.get(c.costAccountId)!.register = accounts.get(c.costAccountId)!.register.plus(live.reduce((t, r) => t.plus(r.a.cost), ZERO));
      accounts.get(c.depreciationAccountId)!.register = accounts.get(c.depreciationAccountId)!.register.plus(live.reduce((t, r) => t.plus(r.acc), ZERO));
    }
    const ids = [...accounts.keys()];
    const ledger = ids.length === 0 ? [] : await tx.$queryRaw<{ account_id: string; code: string; name: string; journal_id: string; journal_number: number; journal_date: Date; source_type: string; description: string; net: string }[]>`
      SELECT l.account_id, a.code, a.name, j.id AS journal_id, j.journal_number, j.journal_date, j.source_type, j.description, sum(l.debit - l.credit)::text AS net
        FROM journal_line l JOIN journal j ON j.id = l.journal_id AND j.organisation_id = l.organisation_id JOIN account a ON a.id = l.account_id AND a.organisation_id = l.organisation_id
       WHERE l.company_id = ${companyId}::uuid AND l.account_id = ANY(${ids}::uuid[]) AND j.journal_date <= ${asAt}::date
       GROUP BY l.account_id, a.code, a.name, j.id, j.journal_number, j.journal_date, j.source_type, j.description ORDER BY a.code, j.journal_date, j.journal_number`;
    const linked = new Map<string, { cost: Money; acc: Money }>();
    for (const r of rows) if (r.a.additionJournalId && r.a.additionKind !== 'POSTED') {
      const x = linked.get(r.a.additionJournalId) ?? { cost: ZERO, acc: ZERO };
      linked.set(r.a.additionJournalId, { cost: x.cost.plus(r.a.cost), acc: x.acc.plus(r.a.takeOnAccumulated) });
    }
    const reconciliation = ids.map((id) => {
      const acct = accounts.get(id)!, ls = ledger.filter((l) => l.account_id === id);
      const net = ls.reduce((t, l) => t.plus(money(l.net)), ZERO);
      const ledgerAmount = acct.kind === 'COST' ? net : net.negated();
      const items = ls.filter((l) => !FA_SOURCES.includes(l.source_type)).map((l) => {
        const amount = acct.kind === 'COST' ? money(l.net) : money(l.net).negated();
        const registered = linked.get(l.journal_id)?.[acct.kind === 'COST' ? 'cost' : 'acc'] ?? ZERO;
        return { journalId: l.journal_id, journalNumber: l.journal_number, journalDate: isoDay(l.journal_date), sourceType: l.source_type, description: l.description, amount: f(amount), registered: f(registered), unregistered: amount.minus(registered) };
      }).filter((i) => !i.unregistered.isZero()).map((i) => ({ ...i, unregistered: f(i.unregistered) }));
      return { accountId: id, code: ls[0]?.code ?? null, kind: acct.kind, register: f(acct.register), ledger: f(ledgerAmount), difference: f(acct.register.minus(ledgerAmount)), reconciled: acct.register.equals(ledgerAmount), items };
    });
    const codes = new Map((await tx.account.findMany({ where: { id: { in: ids } }, select: { id: true, code: true } })).map((a) => [a.id, a.code]));
    return { companyId, currency, asAt, classes: out, reconciliation: reconciliation.map((r) => ({ ...r, code: r.code ?? codes.get(r.accountId)! })).sort((x, y) => (x.code < y.code ? -1 : 1)),
      reconciled: reconciliation.every((r) => r.reconciled) };
  }
}

export class DepreciationService {
  private readonly state = new AssetState();
  constructor(private readonly posting: PostingService, private readonly opts: { captureDeviceMetadata?: boolean } = {}) {}
  private audit(tx: Tx, e: Parameters<typeof auditRow>[0]) { return tx.auditEvent.createMany({ data: [auditRow(e, this.opts.captureDeviceMetadata)] }); }

  /** What a run as at the date would charge (posts nothing). Assets ACTIVE and in use on the date; one line per asset, one pair of journal lines per class. */
  async preview(tx: Tx, companyId: string, asAt: string) {
    const { minor } = await this.state.minor(tx, companyId);
    const later = await tx.depreciationRun.findFirst({ where: { companyId, status: 'POSTED', asAt: { gte: toDate(asAt) } }, orderBy: { asAt: 'desc' }, select: { asAt: true } });
    if (later) throw conflict(`A live run as at ${isoDay(later.asAt)} exists; a new run must be later`, 'run_not_later');
    const assets = await tx.fixedAsset.findMany({ where: { companyId, status: 'ACTIVE', inUseFrom: { lte: toDate(asAt) } }, orderBy: { number: 'asc' } });
    const classes = new Map((await tx.fixedAssetClass.findMany({ where: { companyId } })).map((c) => [c.id, c]));
    const lines = await this.state.liveLines(tx, assets.map((a) => a.id));
    const out: { assetId: string; number: number; description: string; classId: string; classCode: string; amount: Money; accumulatedAfter: Money; carryingAfter: Money }[] = [];
    for (const a of assets) {
      const bases = await this.state.bases(tx, a.id);
      const charged = this.state.charged(a, lines);
      const charge = accumulatedDue(basisOf(bases[bases.length - 1]!), asAt, minor).minus(charged);
      if (charge.greaterThan(0)) out.push({ assetId: a.id, number: a.number, description: a.description, classId: a.classId, classCode: classes.get(a.classId)!.code, amount: charge, accumulatedAfter: charged.plus(charge), carryingAfter: a.cost.minus(charged).minus(charge) });
    }
    const byClass = [...new Set(out.map((l) => l.classId))].map((id) => {
      const c = classes.get(id)!;
      return { classId: id, code: c.code, expenseAccountId: c.expenseAccountId, depreciationAccountId: c.depreciationAccountId, amount: out.filter((l) => l.classId === id).reduce((t, l) => t.plus(l.amount), ZERO) };
    }).sort((x, y) => (x.code < y.code ? -1 : 1));
    const total = out.reduce((t, l) => t.plus(l.amount), ZERO);
    const f = (m: Money) => fmt(m, minor);
    return { raw: { out, byClass, total }, view: { companyId, asAt, total: f(total),
      lines: out.map((l) => ({ assetId: l.assetId, number: l.number, description: l.description, classCode: l.classCode, amount: f(l.amount), accumulatedAfter: f(l.accumulatedAfter), carryingAfter: f(l.carryingAfter) })),
      classes: byClass.map((c) => ({ classId: c.classId, code: c.code, expenseAccountId: c.expenseAccountId, depreciationAccountId: c.depreciationAccountId, amount: f(c.amount) })) } };
  }
  async previewView(tx: Tx, companyId: string, asAt: string) { return (await this.preview(tx, companyId, asAt)).view; }

  async post(tx: Tx, a: Ctx & { asAt: string }) {
    if (a.actor.kind !== 'USER') throw forbidden('Only a person can post depreciation', 'ai_cannot_post');
    if (!(await a.actor.can('assets:manage', a.companyId))) throw forbidden('Requires permission assets:manage', 'permission_denied');
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`depreciation:${a.companyId}`}))`;
    const { raw } = await this.preview(tx, a.companyId, a.asAt);
    if (raw.total.isZero()) throw unprocessable('Nothing to depreciate as at this date', 'nothing_to_depreciate');
    const id = uuidv7();
    const j = await this.posting.post(tx, { organisationId: a.organisationId, companyId: a.companyId, journalDate: a.asAt, sourceType: 'FIXED_ASSET_DEPRECIATION', sourceId: id, sourceReference: `DEPN-${a.asAt}`,
      description: `Depreciation as at ${a.asAt}`, idempotencyKey: `depreciation:${id}`, actor: a.actor,
      lines: raw.byClass.flatMap((c): PostLineInput[] => [
        { accountId: c.expenseAccountId, debit: c.amount.toFixed(4), credit: '0', description: `Depreciation ${c.code} as at ${a.asAt}` },
        { accountId: c.depreciationAccountId, debit: '0', credit: c.amount.toFixed(4), description: `Depreciation ${c.code} as at ${a.asAt}` }]) });
    try {
      await tx.depreciationRun.create({ data: { id, organisationId: a.organisationId, companyId: a.companyId, asAt: toDate(a.asAt), journalId: j.id, total: raw.total, createdByUserId: a.actor.userId! } });
    } catch (e) {
      if (dbMessage(e).includes('later than every live run') || (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw conflict('A run as at this date or later exists', 'run_not_later');
      throw e;
    }
    await tx.depreciationRunLine.createMany({ data: raw.out.map((l) => ({ organisationId: a.organisationId, runId: id, assetId: l.assetId, classId: l.classId, amount: l.amount, accumulatedAfter: l.accumulatedAfter })) });
    await this.audit(tx, { action: 'assets.depreciation_posted', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'depreciation_run', entityId: id,
      after: { asAt: a.asAt, total: raw.total.toFixed(2), journalId: j.id, assets: raw.out.length } });
    return this.get(tx, a.companyId, id);
  }
  /** Only the latest live run, by its own mirror; refused when an asset it charged was later disposed of or had its estimate changed after it. */
  async reverse(tx: Tx, a: Ctx & { id: string; reason: string }) {
    if (a.actor.kind !== 'USER') throw forbidden('Only a person can reverse depreciation', 'ai_cannot_post');
    if (!(await a.actor.can('assets:manage', a.companyId))) throw forbidden('Requires permission assets:manage', 'permission_denied');
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`depreciation:${a.companyId}`}))`;
    const run = await tx.depreciationRun.findFirst({ where: { id: a.id, companyId: a.companyId } });
    if (!run) throw notFound('Depreciation run not found', 'run_not_found');
    if (run.status !== 'POSTED') throw conflict('This run is already reversed', 'run_reversed');
    const later = await tx.depreciationRun.findFirst({ where: { companyId: a.companyId, status: 'POSTED', asAt: { gt: run.asAt } }, select: { asAt: true } });
    if (later) throw conflict(`Only the latest live run can be reversed; reverse the run as at ${isoDay(later.asAt)} first`, 'not_latest_run');
    const lines = await tx.depreciationRunLine.findMany({ where: { runId: run.id } });
    const assetIds = lines.map((l) => l.assetId);
    if (await tx.fixedAsset.findFirst({ where: { id: { in: assetIds }, status: 'DISPOSED' }, select: { id: true } })) throw conflict('An asset this run charged has since been disposed of; reverse the disposal first', 'asset_disposed_after_run');
    if (await tx.fixedAssetBasis.findFirst({ where: { assetId: { in: assetIds }, effectiveFrom: { gt: run.asAt } }, select: { id: true } })) throw conflict('An asset this run charged has a change of estimate that relies on it', 'estimate_changed_after_run');
    const jl = await tx.journalLine.findMany({ where: { journalId: run.journalId! }, orderBy: { lineNo: 'asc' } });
    const j = await this.posting.post(tx, { organisationId: a.organisationId, companyId: a.companyId, journalDate: isoDay(run.asAt), sourceType: 'FIXED_ASSET_DEPRECIATION_REVERSAL', sourceId: run.id, sourceReference: `DEPN-${isoDay(run.asAt)}`,
      description: `Reversal of depreciation as at ${isoDay(run.asAt)}: ${a.reason.trim()}`.slice(0, 500), idempotencyKey: `depreciation-reversal:${run.id}`, actor: a.actor, reason: a.reason,
      lines: jl.map((l): PostLineInput => ({ accountId: l.accountId, debit: l.credit.toFixed(4), credit: l.debit.toFixed(4), description: (l.description ?? 'Reversed').slice(0, 300) })) });
    await tx.depreciationRun.update({ where: { id: run.id }, data: { status: 'REVERSED', reversalJournalId: j.id, reversedByUserId: a.actor.userId!, reversedAt: new Date(), reversedReason: a.reason.trim() } });
    await this.audit(tx, { action: 'assets.depreciation_reversed', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'depreciation_run', entityId: run.id,
      before: { status: 'POSTED' }, after: { status: 'REVERSED', reversalJournalId: j.id }, reason: a.reason });
    return this.get(tx, a.companyId, run.id);
  }
  async get(tx: Tx, companyId: string, id: string) {
    const r = await tx.depreciationRun.findFirst({ where: { id, companyId } });
    if (!r) throw notFound('Depreciation run not found', 'run_not_found');
    const { minor } = await this.state.minor(tx, companyId);
    const lines = await tx.depreciationRunLine.findMany({ where: { runId: id } });
    const assets = new Map((await tx.fixedAsset.findMany({ where: { id: { in: lines.map((l) => l.assetId) } }, select: { id: true, number: true, description: true } })).map((a) => [a.id, a]));
    return { ...this.view(r, minor), lines: lines.map((l) => ({ assetId: l.assetId, number: assets.get(l.assetId)!.number, description: assets.get(l.assetId)!.description, classId: l.classId, amount: fmt(l.amount, minor), accumulatedAfter: fmt(l.accumulatedAfter, minor) }))
      .sort((x, y) => x.number - y.number) };
  }
  private view(r: Awaited<ReturnType<Tx['depreciationRun']['findUniqueOrThrow']>>, minor: number) {
    return { id: r.id, companyId: r.companyId, asAt: isoDay(r.asAt), status: r.status, journalId: r.journalId, reversalJournalId: r.reversalJournalId, total: fmt(r.total, minor), createdByUserId: r.createdByUserId,
      createdAt: r.createdAt, reversedByUserId: r.reversedByUserId, reversedAt: r.reversedAt, reversedReason: r.reversedReason };
  }
  async list(tx: Tx, companyId: string) {
    const { minor } = await this.state.minor(tx, companyId);
    return { items: (await tx.depreciationRun.findMany({ where: { companyId }, orderBy: [{ asAt: 'asc' }, { createdAt: 'asc' }] })).map((r) => this.view(r, minor)) };
  }
}
