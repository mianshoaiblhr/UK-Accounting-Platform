import { checkExpression, expressionLines, lineShapeErrors, type EntitySize } from '@uk/contracts';
import { conflict, forbidden, notFound, unprocessable, uuidv7 } from '@uk/core';
import { Prisma, type Tx } from '@uk/db';
import { auditRow } from '@uk/platform';

/**
 * V2-M1 reporting framework (DEC-052, DEC-053, DEC-055; ADR-62). Standards and their effective-dated versions; per version the statement lines,
 * the map from V1 reporting lines, validation and disclosure rules; the framework a company reports under per financial year and its account
 * overrides. Content is written only while a version is UNVERIFIED; a second person holding `accounts:rule-verify` verifies it; a verified version
 * is immutable and changed by superseding it. The database enforces the same rules. No standard content exists in code (DEC-052).
 */
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);

export interface RuleActor { userId: string; kind?: string; can(permission: string, companyId: string): boolean | Promise<boolean> }
type Ctx = { organisationId: string; companyId: string; actor: RuleActor };
type VersionRow = Awaited<ReturnType<Tx['reportingStandardVersion']['findUniqueOrThrow']>>;
type LineRow = Awaited<ReturnType<Tx['statutoryLine']['findUniqueOrThrow']>>;
type MapRow = Awaited<ReturnType<Tx['statutoryMapEntry']['findUniqueOrThrow']>>;
type RuleRow = Awaited<ReturnType<Tx['validationRule']['findUniqueOrThrow']>>;
type NoteRow = Awaited<ReturnType<Tx['disclosureRule']['findUniqueOrThrow']>>;
type Term = { line: string; sign: number };
interface Source { url: string; provision: string; retrievedOn: string }

export const standardVersionView = (v: VersionRow) => ({
  id: v.id, standardId: v.standardId, label: v.label, effectiveFrom: isoDay(v.effectiveFrom), effectiveTo: v.effectiveTo ? isoDay(v.effectiveTo) : null,
  source: { url: v.sourceUrl, provision: v.sourceReference, retrievedOn: isoDay(v.sourceRetrievedOn) }, notes: v.notes, status: v.status, copiedFromId: v.copiedFromId,
  createdByUserId: v.createdByUserId, createdAt: v.createdAt, verifiedByUserId: v.verifiedByUserId, verifiedAt: v.verifiedAt, verificationNotes: v.verificationNotes, supersededById: v.supersededById,
});
export const statutoryLineView = (l: LineRow) => ({ id: l.id, key: l.key, statement: l.statement, parentKey: l.parentKey, sort: l.sort, name: l.name, kind: l.kind, naturalSide: l.naturalSide, formula: (l.formula as Term[] | null) ?? null });
const mapView = (m: MapRow) => ({ id: m.id, sourceLine: m.sourceLine, accountSubtype: m.accountSubtype, targetKey: m.targetKey });
const ruleView = (r: RuleRow) => ({ id: r.id, key: r.key, description: r.description, severity: r.severity, appliesTo: r.appliesTo, expression: r.expression as Record<string, unknown> });
const noteView = (n: NoteRow) => ({ id: n.id, key: n.key, title: n.title, appliesTo: n.appliesTo, requires: n.requires as { lines?: string[]; facts?: string[] } });

/** Lines a total depends on, transitively; returns the first cycle found as a list of keys, or null. */
function findCycle(formulas: Map<string, Term[]>): string[] | null {
  const state = new Map<string, 1 | 2>();
  const walk = (k: string, path: string[]): string[] | null => {
    if (state.get(k) === 2) return null;
    if (state.get(k) === 1) return [...path.slice(path.indexOf(k)), k];
    state.set(k, 1);
    for (const t of formulas.get(k) ?? []) { const c = walk(t.line, [...path, k]); if (c) return c; }
    state.set(k, 2);
    return null;
  };
  for (const k of formulas.keys()) { const c = walk(k, []); if (c) return c; }
  return null;
}

/**
 * The consistency of a version's content (DEC-055): everything refers to lines of the version, totals and parents have no cycle, parents sit on
 * the same statement, map entries and overrides land on accounts lines, rule expressions follow the grammar. Empty = consistent.
 */
export function versionProblems(c: { lines: LineRow[]; map: MapRow[]; rules: RuleRow[]; notes: NoteRow[]; overrideTargets?: string[] }): string[] {
  const p: string[] = [];
  const byKey = new Map(c.lines.map((l) => [l.key, l]));
  if (c.lines.length === 0) p.push('The version has no statement lines');
  for (const l of c.lines) {
    for (const m of lineShapeErrors({ ...l, formula: l.formula as Term[] | null })) p.push(`Line ${l.key}: ${m}`);
    if (l.parentKey) {
      const parent = byKey.get(l.parentKey);
      if (!parent) p.push(`Line ${l.key}: parent ${l.parentKey} is not a line of this version`);
      else if (parent.statement !== l.statement) p.push(`Line ${l.key}: parent ${l.parentKey} is on another statement`);
    }
    for (const t of (l.formula as Term[] | null) ?? []) if (!byKey.has(t.line)) p.push(`Line ${l.key}: total refers to ${t.line}, not a line of this version`);
  }
  const cycle = findCycle(new Map(c.lines.filter((l) => l.formula).map((l) => [l.key, l.formula as Term[]])));
  if (cycle) p.push(`Totals form a cycle: ${cycle.join(' -> ')}`);
  const parentCycle = findCycle(new Map(c.lines.filter((l) => l.parentKey).map((l) => [l.key, [{ line: l.parentKey!, sign: 1 }]])));
  if (parentCycle) p.push(`Parents form a cycle: ${parentCycle.join(' -> ')}`);
  const accountsLine = (k: string) => byKey.get(k)?.kind === 'ACCOUNTS';
  for (const m of c.map) if (!accountsLine(m.targetKey)) p.push(`Map ${m.sourceLine}${m.accountSubtype ? `/${m.accountSubtype}` : ''}: ${m.targetKey} is not an accounts line of this version`);
  for (const k of c.overrideTargets ?? []) if (!accountsLine(k)) p.push(`An account override targets ${k}, not an accounts line of this version`);
  const keys = new Set(byKey.keys());
  for (const r of c.rules) for (const e of checkExpression(r.expression, keys)) p.push(`Rule ${r.key}: ${e}`);
  for (const n of c.notes) for (const k of (n.requires as { lines?: string[] }).lines ?? []) if (!keys.has(k)) p.push(`Disclosure ${n.key}: ${k} is not a line of this version`);
  return p;
}

const dbMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class StandardsService {
  constructor(private readonly opts: { captureDeviceMetadata?: boolean } = {}) {}
  private audit(tx: Tx, e: Parameters<typeof auditRow>[0]) { return tx.auditEvent.createMany({ data: [auditRow(e, this.opts.captureDeviceMetadata)] }); }
  private async need(actor: RuleActor, permission: string, companyId: string) {
    if (actor.kind && actor.kind !== 'USER') throw forbidden('Only a person can change accounting-standard rules', 'ai_cannot_post');
    if (!(await actor.can(permission, companyId))) throw forbidden(`Requires permission ${permission}`, 'permission_denied');
  }
  private async version(tx: Tx, id: string) {
    const v = await tx.reportingStandardVersion.findFirst({ where: { id } });
    if (!v) throw notFound('Standard version not found', 'standard_version_not_found');
    return v;
  }
  /** Content changes only while the version is UNVERIFIED (the database repeats this). */
  private async editable(tx: Tx, id: string) {
    const v = await this.version(tx, id);
    if (v.status !== 'UNVERIFIED') throw conflict(`The version is ${v.status.toLowerCase()} and cannot change; supersede it with a new version`, 'version_not_editable');
    return v;
  }
  private async content(tx: Tx, versionId: string) {
    const where = { versionId, removed: false };
    const [lines, map, rules, notes] = await Promise.all([
      tx.statutoryLine.findMany({ where, orderBy: [{ statement: 'asc' }, { sort: 'asc' }, { key: 'asc' }] }),
      tx.statutoryMapEntry.findMany({ where, orderBy: [{ sourceLine: 'asc' }, { accountSubtype: 'asc' }] }),
      tx.validationRule.findMany({ where, orderBy: { key: 'asc' } }),
      tx.disclosureRule.findMany({ where, orderBy: { key: 'asc' } }),
    ]);
    return { lines, map, rules, notes };
  }
  private mapDb(e: unknown): never {
    const msg = dbMessage(e);
    if (msg.includes('overlaps another current version')) throw conflict('These dates overlap another current version of this standard; supersede it or end it first', 'version_overlap');
    throw e;
  }

  // ───── Standards and versions ─────
  async listStandards(tx: Tx) {
    const [standards, versions] = await Promise.all([
      tx.reportingStandard.findMany({ orderBy: { code: 'asc' } }),
      tx.reportingStandardVersion.findMany({ orderBy: [{ effectiveFrom: 'asc' }, { createdAt: 'asc' }] }),
    ]);
    return { items: standards.map((s) => ({ id: s.id, code: s.code, name: s.name, createdByUserId: s.createdByUserId, createdAt: s.createdAt,
      versions: versions.filter((v) => v.standardId === s.id).map((v) => ({ id: v.id, label: v.label, effectiveFrom: isoDay(v.effectiveFrom), effectiveTo: v.effectiveTo ? isoDay(v.effectiveTo) : null, status: v.status })) })) };
  }
  async createStandard(tx: Tx, a: Ctx & { code: string; name: string }) {
    await this.need(a.actor, 'accounts:rules-manage', a.companyId);
    try {
      const s = await tx.reportingStandard.create({ data: { organisationId: a.organisationId, code: a.code, name: a.name, createdByUserId: a.actor.userId } });
      await this.audit(tx, { action: 'accounts.standard_created', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'reporting_standard', entityId: s.id, after: { code: s.code, name: s.name } });
      return { id: s.id, code: s.code, name: s.name, createdByUserId: s.createdByUserId, createdAt: s.createdAt, versions: [] };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict(`Standard ${a.code} already exists`, 'standard_exists');
      throw e;
    }
  }
  async listVersions(tx: Tx, standardId: string) {
    if (!(await tx.reportingStandard.findFirst({ where: { id: standardId }, select: { id: true } }))) throw notFound('Standard not found', 'standard_not_found');
    const rows = await tx.reportingStandardVersion.findMany({ where: { standardId }, orderBy: [{ effectiveFrom: 'asc' }, { createdAt: 'asc' }] });
    return { items: rows.map(standardVersionView) };
  }
  async getVersion(tx: Tx, id: string) {
    const v = await this.version(tx, id);
    const s = await tx.reportingStandard.findFirstOrThrow({ where: { id: v.standardId } });
    const c = await this.content(tx, id);
    return { ...standardVersionView(v), standard: { id: s.id, code: s.code, name: s.name }, lines: c.lines.map(statutoryLineView), mapEntries: c.map.map(mapView),
      validationRules: c.rules.map(ruleView), disclosureRules: c.notes.map(noteView), problems: versionProblems(c) };
  }

  /** Copies the live content of one version into another (a new version, or a supersession). */
  private async copyContent(tx: Tx, organisationId: string, fromId: string, toId: string) {
    const c = await this.content(tx, fromId);
    if (c.lines.length) await tx.statutoryLine.createMany({ data: c.lines.map((l) => ({ organisationId, versionId: toId, key: l.key, statement: l.statement, parentKey: l.parentKey, sort: l.sort, name: l.name, kind: l.kind, naturalSide: l.naturalSide, formula: l.formula ?? Prisma.DbNull })) });
    if (c.map.length) await tx.statutoryMapEntry.createMany({ data: c.map.map((m) => ({ organisationId, versionId: toId, sourceLine: m.sourceLine, accountSubtype: m.accountSubtype, targetKey: m.targetKey })) });
    if (c.rules.length) await tx.validationRule.createMany({ data: c.rules.map((r) => ({ organisationId, versionId: toId, key: r.key, description: r.description, severity: r.severity, appliesTo: r.appliesTo, expression: r.expression as Prisma.InputJsonValue })) });
    if (c.notes.length) await tx.disclosureRule.createMany({ data: c.notes.map((n) => ({ organisationId, versionId: toId, key: n.key, title: n.title, appliesTo: n.appliesTo, requires: n.requires as Prisma.InputJsonValue })) });
  }
  async createVersion(tx: Tx, a: Ctx & { standardId: string; label: string; effectiveFrom: string; effectiveTo?: string; source: Source; notes?: string; copyFromVersionId?: string }) {
    await this.need(a.actor, 'accounts:rules-manage', a.companyId);
    if (!(await tx.reportingStandard.findFirst({ where: { id: a.standardId }, select: { id: true } }))) throw notFound('Standard not found', 'standard_not_found');
    if (a.copyFromVersionId) await this.version(tx, a.copyFromVersionId);
    let v: VersionRow;
    try {
      v = await tx.reportingStandardVersion.create({ data: { organisationId: a.organisationId, standardId: a.standardId, label: a.label, effectiveFrom: toDate(a.effectiveFrom), effectiveTo: a.effectiveTo ? toDate(a.effectiveTo) : null,
        sourceUrl: a.source.url, sourceReference: a.source.provision, sourceRetrievedOn: toDate(a.source.retrievedOn), notes: a.notes ?? null, copiedFromId: a.copyFromVersionId ?? null, createdByUserId: a.actor.userId } });
    } catch (e) { this.mapDb(e); }
    if (a.copyFromVersionId) await this.copyContent(tx, a.organisationId, a.copyFromVersionId, v.id);
    await this.audit(tx, { action: 'accounts.standard_version_created', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'reporting_standard_version', entityId: v.id, after: standardVersionView(v) });
    return this.getVersion(tx, v.id);
  }
  async updateVersion(tx: Tx, a: Ctx & { id: string; label?: string; effectiveFrom?: string; effectiveTo?: string | null; source?: Source; notes?: string | null }) {
    await this.need(a.actor, 'accounts:rules-manage', a.companyId);
    const before = await this.editable(tx, a.id);
    const from = a.effectiveFrom ?? isoDay(before.effectiveFrom), to = a.effectiveTo === undefined ? (before.effectiveTo ? isoDay(before.effectiveTo) : null) : a.effectiveTo;
    if (to && to < from) throw unprocessable('effectiveTo cannot precede effectiveFrom', 'invalid_date');
    let after: VersionRow;
    try {
      after = await tx.reportingStandardVersion.update({ where: { id: a.id }, data: {
        ...(a.label !== undefined ? { label: a.label } : {}), effectiveFrom: toDate(from), effectiveTo: to ? toDate(to) : null,
        ...(a.source ? { sourceUrl: a.source.url, sourceReference: a.source.provision, sourceRetrievedOn: toDate(a.source.retrievedOn) } : {}),
        ...(a.notes !== undefined ? { notes: a.notes } : {}) } });
    } catch (e) { this.mapDb(e); }
    await this.audit(tx, { action: 'accounts.standard_version_changed', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'reporting_standard_version', entityId: a.id, before: standardVersionView(before), after: standardVersionView(after) });
    return this.getVersion(tx, a.id);
  }
  async verify(tx: Tx, a: Ctx & { id: string; notes: string }) {
    await this.need(a.actor, 'accounts:rule-verify', a.companyId);
    const v = await this.version(tx, a.id);
    if (v.status === 'VERIFIED') throw conflict('This version is already verified', 'already_verified');
    if (v.status === 'SUPERSEDED') throw conflict('A superseded version cannot be verified', 'version_superseded');
    if (v.createdByUserId === a.actor.userId) throw forbidden('A standard version must be verified by someone other than its author', 'self_verification_not_allowed');
    const c = await this.content(tx, a.id);
    const overrides = await tx.statutoryAccountOverride.findMany({ where: { versionId: a.id, endedAt: null }, select: { targetKey: true } });
    const problems = versionProblems({ ...c, overrideTargets: overrides.map((o) => o.targetKey) });
    if (problems.length) throw unprocessable('The version is not consistent and cannot be verified', 'version_inconsistent', { problems });
    const after = await tx.reportingStandardVersion.update({ where: { id: a.id }, data: { status: 'VERIFIED', verifiedByUserId: a.actor.userId, verifiedAt: new Date(), verificationNotes: a.notes } });
    await this.audit(tx, { action: 'accounts.standard_version_verified', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'reporting_standard_version', entityId: a.id,
      before: { status: v.status }, after: { status: after.status, verifiedByUserId: after.verifiedByUserId, verificationNotes: after.verificationNotes, lines: c.lines.length, mapEntries: c.map.length, validationRules: c.rules.length, disclosureRules: c.notes.length } });
    return this.getVersion(tx, a.id);
  }
  /** A change to a verified version (DEC-055): a new UNVERIFIED version with the same content, and the old one marked SUPERSEDED, in one transaction. */
  async supersede(tx: Tx, a: Ctx & { id: string; label: string; effectiveFrom: string; effectiveTo?: string; source: Source; notes?: string; reason: string }) {
    await this.need(a.actor, 'accounts:rules-manage', a.companyId);
    const old = await this.version(tx, a.id);
    if (old.status === 'UNVERIFIED') throw conflict('An unverified version is edited, not superseded', 'version_unverified');
    if (old.status === 'SUPERSEDED') throw conflict('This version was already superseded', 'version_superseded');
    const id = uuidv7();
    await tx.reportingStandardVersion.update({ where: { id: old.id }, data: { status: 'SUPERSEDED', supersededById: id } });
    let v: VersionRow;
    try {
      v = await tx.reportingStandardVersion.create({ data: { id, organisationId: a.organisationId, standardId: old.standardId, label: a.label, effectiveFrom: toDate(a.effectiveFrom), effectiveTo: a.effectiveTo ? toDate(a.effectiveTo) : null,
        sourceUrl: a.source.url, sourceReference: a.source.provision, sourceRetrievedOn: toDate(a.source.retrievedOn), notes: a.notes ?? null, copiedFromId: old.id, createdByUserId: a.actor.userId } });
    } catch (e) { this.mapDb(e); }
    await this.copyContent(tx, a.organisationId, old.id, id);
    await this.audit(tx, { action: 'accounts.standard_version_superseded', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'reporting_standard_version', entityId: old.id,
      before: { status: old.status }, after: { status: 'SUPERSEDED', supersededById: id, newVersion: standardVersionView(v) }, reason: a.reason });
    return this.getVersion(tx, id);
  }

  // ───── Content (only while UNVERIFIED) ─────
  private async lineKeys(tx: Tx, versionId: string) { return new Map((await tx.statutoryLine.findMany({ where: { versionId, removed: false } })).map((l) => [l.key, l])); }
  private checkTotal(lines: Map<string, LineRow>, key: string, formula: Term[] | null | undefined) {
    if (!formula) return;
    const missing = formula.filter((t) => !lines.has(t.line)).map((t) => t.line);
    if (missing.length) throw unprocessable(`The total refers to lines not in this version: ${missing.join(', ')}`, 'unknown_line', { lines: missing });
    const formulas = new Map([...lines.values()].filter((l) => l.formula && l.key !== key).map((l) => [l.key, l.formula as Term[]]));
    formulas.set(key, formula);
    const cycle = findCycle(formulas);
    if (cycle) throw unprocessable(`The totals would form a cycle: ${cycle.join(' -> ')}`, 'total_cycle', { cycle });
  }
  private async lineInUse(tx: Tx, versionId: string, key: string) {
    const [lines, map, rules, notes, overrides] = await Promise.all([
      tx.statutoryLine.findMany({ where: { versionId, removed: false } }), tx.statutoryMapEntry.count({ where: { versionId, removed: false, targetKey: key } }),
      tx.validationRule.findMany({ where: { versionId, removed: false } }), tx.disclosureRule.findMany({ where: { versionId, removed: false } }),
      tx.statutoryAccountOverride.count({ where: { versionId, endedAt: null, targetKey: key } }),
    ]);
    const uses: string[] = [];
    for (const l of lines) {
      if (l.parentKey === key) uses.push(`parent of ${l.key}`);
      if (((l.formula as Term[] | null) ?? []).some((t) => t.line === key)) uses.push(`in total ${l.key}`);
    }
    if (map) uses.push(`target of ${map} map entr${map === 1 ? 'y' : 'ies'}`);
    if (overrides) uses.push(`target of ${overrides} account override${overrides === 1 ? '' : 's'}`);
    for (const r of rules) if (expressionLines(r.expression).has(key)) uses.push(`in rule ${r.key}`);
    for (const n of notes) if (((n.requires as { lines?: string[] }).lines ?? []).includes(key)) uses.push(`in disclosure ${n.key}`);
    return uses;
  }
  private async contentAudit(tx: Tx, a: Ctx, action: string, entityType: string, entityId: string, before?: object, after?: object) {
    await this.audit(tx, { action, organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType, entityId, before: before as Record<string, unknown> | undefined, after: after as Record<string, unknown> | undefined });
  }
  private dup(e: unknown, what: string): never {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict(`${what} already exists in this version`, 'content_exists');
    throw e;
  }

  async addLine(tx: Tx, a: Ctx & { versionId: string; key: string; statement: string; parentKey?: string | null; sort: number; name: string; kind: string; naturalSide?: string | null; formula?: Term[] | null }) {
    await this.need(a.actor, 'accounts:rules-manage', a.companyId);
    await this.editable(tx, a.versionId);
    const lines = await this.lineKeys(tx, a.versionId);
    this.checkTotal(lines, a.key, a.formula);
    let l: LineRow;
    try {
      l = await tx.statutoryLine.create({ data: { organisationId: a.organisationId, versionId: a.versionId, key: a.key, statement: a.statement, parentKey: a.parentKey ?? null, sort: a.sort, name: a.name, kind: a.kind,
        naturalSide: a.naturalSide ?? null, formula: a.formula ? (a.formula as Prisma.InputJsonValue) : Prisma.DbNull } });
    } catch (e) { this.dup(e, `Line ${a.key}`); }
    await this.contentAudit(tx, a, 'accounts.line_added', 'statutory_line', l.id, undefined, statutoryLineView(l));
    return statutoryLineView(l);
  }
  private async line(tx: Tx, versionId: string, id: string) {
    const l = await tx.statutoryLine.findFirst({ where: { id, versionId, removed: false } });
    if (!l) throw notFound('Line not found', 'line_not_found');
    return l;
  }
  async updateLine(tx: Tx, a: Ctx & { versionId: string; id: string; statement?: string; parentKey?: string | null; sort?: number; name?: string; kind?: string; naturalSide?: string | null; formula?: Term[] | null }) {
    await this.need(a.actor, 'accounts:rules-manage', a.companyId);
    await this.editable(tx, a.versionId);
    const before = await this.line(tx, a.versionId, a.id);
    const merged = { key: before.key, statement: a.statement ?? before.statement, parentKey: a.parentKey === undefined ? before.parentKey : a.parentKey, sort: a.sort ?? before.sort, name: a.name ?? before.name,
      kind: a.kind ?? before.kind, naturalSide: a.naturalSide === undefined ? before.naturalSide : a.naturalSide, formula: a.formula === undefined ? (before.formula as Term[] | null) : a.formula };
    const shape = lineShapeErrors(merged);
    if (shape.length) throw unprocessable(shape.join('; '), 'invalid_line', { problems: shape });
    if (merged.kind !== 'ACCOUNTS' && before.kind === 'ACCOUNTS') {
      const fed = await tx.statutoryMapEntry.count({ where: { versionId: a.versionId, removed: false, targetKey: before.key } }) + await tx.statutoryAccountOverride.count({ where: { versionId: a.versionId, endedAt: null, targetKey: before.key } });
      if (fed) throw conflict('Map entries or overrides feed this line; move them before changing its kind', 'line_in_use');
    }
    this.checkTotal(await this.lineKeys(tx, a.versionId), before.key, merged.formula);
    const after = await tx.statutoryLine.update({ where: { id: a.id }, data: { statement: merged.statement, parentKey: merged.parentKey, sort: merged.sort, name: merged.name, kind: merged.kind, naturalSide: merged.naturalSide,
      formula: merged.formula ? (merged.formula as Prisma.InputJsonValue) : Prisma.DbNull } });
    await this.contentAudit(tx, a, 'accounts.line_changed', 'statutory_line', a.id, statutoryLineView(before), statutoryLineView(after));
    return statutoryLineView(after);
  }
  async removeLine(tx: Tx, a: Ctx & { versionId: string; id: string }) {
    await this.need(a.actor, 'accounts:rules-manage', a.companyId);
    await this.editable(tx, a.versionId);
    const l = await this.line(tx, a.versionId, a.id);
    const uses = await this.lineInUse(tx, a.versionId, l.key);
    if (uses.length) throw conflict(`Line ${l.key} is in use: ${uses.join('; ')}`, 'line_in_use', { uses });
    await tx.statutoryLine.update({ where: { id: a.id }, data: { removed: true } });
    await this.contentAudit(tx, a, 'accounts.line_removed', 'statutory_line', a.id, statutoryLineView(l));
    return { id: a.id, removed: true };
  }

  private async accountsTarget(tx: Tx, versionId: string, key: string) {
    const l = await tx.statutoryLine.findFirst({ where: { versionId, key, removed: false }, select: { kind: true } });
    if (l?.kind !== 'ACCOUNTS') throw unprocessable(`${key} is not an accounts line of this version`, 'unknown_line', { lines: [key] });
  }
  private async mapEntry(tx: Tx, versionId: string, id: string) {
    const m = await tx.statutoryMapEntry.findFirst({ where: { id, versionId, removed: false } });
    if (!m) throw notFound('Map entry not found', 'map_entry_not_found');
    return m;
  }
  async addMapEntry(tx: Tx, a: Ctx & { versionId: string; sourceLine: string; accountSubtype?: string | null; targetKey: string }) {
    await this.need(a.actor, 'accounts:rules-manage', a.companyId);
    await this.editable(tx, a.versionId);
    await this.accountsTarget(tx, a.versionId, a.targetKey);
    let m: MapRow;
    try { m = await tx.statutoryMapEntry.create({ data: { organisationId: a.organisationId, versionId: a.versionId, sourceLine: a.sourceLine, accountSubtype: a.accountSubtype ?? null, targetKey: a.targetKey } }); }
    catch (e) { this.dup(e, `A map entry for ${a.sourceLine}${a.accountSubtype ? `/${a.accountSubtype}` : ''}`); }
    await this.contentAudit(tx, a, 'accounts.map_entry_added', 'statutory_map_entry', m.id, undefined, mapView(m));
    return mapView(m);
  }
  async updateMapEntry(tx: Tx, a: Ctx & { versionId: string; id: string; targetKey: string }) {
    await this.need(a.actor, 'accounts:rules-manage', a.companyId);
    await this.editable(tx, a.versionId);
    const before = await this.mapEntry(tx, a.versionId, a.id);
    await this.accountsTarget(tx, a.versionId, a.targetKey);
    const after = await tx.statutoryMapEntry.update({ where: { id: a.id }, data: { targetKey: a.targetKey } });
    await this.contentAudit(tx, a, 'accounts.map_entry_changed', 'statutory_map_entry', a.id, mapView(before), mapView(after));
    return mapView(after);
  }
  async removeMapEntry(tx: Tx, a: Ctx & { versionId: string; id: string }) {
    await this.need(a.actor, 'accounts:rules-manage', a.companyId);
    await this.editable(tx, a.versionId);
    const m = await this.mapEntry(tx, a.versionId, a.id);
    await tx.statutoryMapEntry.update({ where: { id: a.id }, data: { removed: true } });
    await this.contentAudit(tx, a, 'accounts.map_entry_removed', 'statutory_map_entry', a.id, mapView(m));
    return { id: a.id, removed: true };
  }

  private async checkRule(tx: Tx, versionId: string, expression: unknown) {
    const problems = checkExpression(expression, new Set((await this.lineKeys(tx, versionId)).keys()));
    if (problems.length) throw unprocessable('The expression does not follow the rule grammar', 'invalid_expression', { problems });
  }
  private async rule(tx: Tx, versionId: string, id: string) {
    const r = await tx.validationRule.findFirst({ where: { id, versionId, removed: false } });
    if (!r) throw notFound('Validation rule not found', 'rule_not_found');
    return r;
  }
  async addValidationRule(tx: Tx, a: Ctx & { versionId: string; key: string; description: string; severity: string; appliesTo: EntitySize[]; expression: Record<string, unknown> }) {
    await this.need(a.actor, 'accounts:rules-manage', a.companyId);
    await this.editable(tx, a.versionId);
    await this.checkRule(tx, a.versionId, a.expression);
    let r: RuleRow;
    try { r = await tx.validationRule.create({ data: { organisationId: a.organisationId, versionId: a.versionId, key: a.key, description: a.description, severity: a.severity, appliesTo: a.appliesTo, expression: a.expression as Prisma.InputJsonValue } }); }
    catch (e) { this.dup(e, `Rule ${a.key}`); }
    await this.contentAudit(tx, a, 'accounts.validation_rule_added', 'validation_rule', r.id, undefined, ruleView(r));
    return ruleView(r);
  }
  async updateValidationRule(tx: Tx, a: Ctx & { versionId: string; id: string; description?: string; severity?: string; appliesTo?: EntitySize[]; expression?: Record<string, unknown> }) {
    await this.need(a.actor, 'accounts:rules-manage', a.companyId);
    await this.editable(tx, a.versionId);
    const before = await this.rule(tx, a.versionId, a.id);
    if (a.expression) await this.checkRule(tx, a.versionId, a.expression);
    const after = await tx.validationRule.update({ where: { id: a.id }, data: { ...(a.description !== undefined ? { description: a.description } : {}), ...(a.severity ? { severity: a.severity } : {}),
      ...(a.appliesTo ? { appliesTo: a.appliesTo } : {}), ...(a.expression ? { expression: a.expression as Prisma.InputJsonValue } : {}) } });
    await this.contentAudit(tx, a, 'accounts.validation_rule_changed', 'validation_rule', a.id, ruleView(before), ruleView(after));
    return ruleView(after);
  }
  async removeValidationRule(tx: Tx, a: Ctx & { versionId: string; id: string }) {
    await this.need(a.actor, 'accounts:rules-manage', a.companyId);
    await this.editable(tx, a.versionId);
    const r = await this.rule(tx, a.versionId, a.id);
    await tx.validationRule.update({ where: { id: a.id }, data: { removed: true } });
    await this.contentAudit(tx, a, 'accounts.validation_rule_removed', 'validation_rule', a.id, ruleView(r));
    return { id: a.id, removed: true };
  }

  private async checkNote(tx: Tx, versionId: string, requires: { lines?: string[] }) {
    const keys = await this.lineKeys(tx, versionId);
    const missing = (requires.lines ?? []).filter((k) => !keys.has(k));
    if (missing.length) throw unprocessable(`The disclosure refers to lines not in this version: ${missing.join(', ')}`, 'unknown_line', { lines: missing });
  }
  private async note(tx: Tx, versionId: string, id: string) {
    const n = await tx.disclosureRule.findFirst({ where: { id, versionId, removed: false } });
    if (!n) throw notFound('Disclosure rule not found', 'disclosure_not_found');
    return n;
  }
  async addDisclosureRule(tx: Tx, a: Ctx & { versionId: string; key: string; title: string; appliesTo: EntitySize[]; requires: { lines?: string[]; facts?: string[] } }) {
    await this.need(a.actor, 'accounts:rules-manage', a.companyId);
    await this.editable(tx, a.versionId);
    await this.checkNote(tx, a.versionId, a.requires);
    let n: NoteRow;
    try { n = await tx.disclosureRule.create({ data: { organisationId: a.organisationId, versionId: a.versionId, key: a.key, title: a.title, appliesTo: a.appliesTo, requires: a.requires as Prisma.InputJsonValue } }); }
    catch (e) { this.dup(e, `Disclosure ${a.key}`); }
    await this.contentAudit(tx, a, 'accounts.disclosure_rule_added', 'disclosure_rule', n.id, undefined, noteView(n));
    return noteView(n);
  }
  async updateDisclosureRule(tx: Tx, a: Ctx & { versionId: string; id: string; title?: string; appliesTo?: EntitySize[]; requires?: { lines?: string[]; facts?: string[] } }) {
    await this.need(a.actor, 'accounts:rules-manage', a.companyId);
    await this.editable(tx, a.versionId);
    const before = await this.note(tx, a.versionId, a.id);
    if (a.requires) await this.checkNote(tx, a.versionId, a.requires);
    const after = await tx.disclosureRule.update({ where: { id: a.id }, data: { ...(a.title !== undefined ? { title: a.title } : {}), ...(a.appliesTo ? { appliesTo: a.appliesTo } : {}), ...(a.requires ? { requires: a.requires as Prisma.InputJsonValue } : {}) } });
    await this.contentAudit(tx, a, 'accounts.disclosure_rule_changed', 'disclosure_rule', a.id, noteView(before), noteView(after));
    return noteView(after);
  }
  async removeDisclosureRule(tx: Tx, a: Ctx & { versionId: string; id: string }) {
    await this.need(a.actor, 'accounts:rules-manage', a.companyId);
    await this.editable(tx, a.versionId);
    const n = await this.note(tx, a.versionId, a.id);
    await tx.disclosureRule.update({ where: { id: a.id }, data: { removed: true } });
    await this.contentAudit(tx, a, 'accounts.disclosure_rule_removed', 'disclosure_rule', a.id, noteView(n));
    return { id: a.id, removed: true };
  }
}

// ───── The framework of each financial year, and account overrides ─────
type FrameworkRow = Awaited<ReturnType<Tx['companyReportingFramework']['findUniqueOrThrow']>>;
type OverrideRow = Awaited<ReturnType<Tx['statutoryAccountOverride']['findUniqueOrThrow']>>;
const frameworkView = (f: FrameworkRow, v?: { label: string; status: string; standardId: string }) => ({
  id: f.id, companyId: f.companyId, yearStart: isoDay(f.yearStart), yearEnd: isoDay(f.yearEnd), versionId: f.versionId, entitySize: f.entitySize, reason: f.reason,
  chosenByUserId: f.chosenByUserId, chosenAt: f.chosenAt, lockedAt: f.lockedAt, ...(v ? { version: { label: v.label, status: v.status, standardId: v.standardId } } : {}),
});
const overrideView = (o: OverrideRow) => ({
  id: o.id, companyId: o.companyId, versionId: o.versionId, accountId: o.accountId, targetKey: o.targetKey, reason: o.reason, createdByUserId: o.createdByUserId, createdAt: o.createdAt,
  endedAt: o.endedAt, endedByUserId: o.endedByUserId, endedReason: o.endedReason,
});

export class FrameworkService {
  constructor(private readonly opts: { captureDeviceMetadata?: boolean } = {}) {}
  private audit(tx: Tx, e: Parameters<typeof auditRow>[0]) { return tx.auditEvent.createMany({ data: [auditRow(e, this.opts.captureDeviceMetadata)] }); }
  private async need(actor: RuleActor, companyId: string) {
    if (actor.kind && actor.kind !== 'USER') throw forbidden('Only a person can choose a reporting framework', 'ai_cannot_post');
    if (!(await actor.can('accounts:prepare', companyId))) throw forbidden('Requires permission accounts:prepare', 'permission_denied');
  }

  async list(tx: Tx, companyId: string) {
    const rows = await tx.companyReportingFramework.findMany({ where: { companyId }, orderBy: { yearStart: 'asc' } });
    const versions = new Map((await tx.reportingStandardVersion.findMany({ where: { id: { in: rows.map((r) => r.versionId) } } })).map((v) => [v.id, v]));
    return { items: rows.map((r) => frameworkView(r, versions.get(r.versionId))) };
  }
  /** Chooses (or changes, with a reason) the version and entity size of one financial year (DEC-055). */
  async set(tx: Tx, a: Ctx & { yearStart: string; yearEnd: string; versionId: string; entitySize: EntitySize; reason: string }) {
    await this.need(a.actor, a.companyId);
    const v = await tx.reportingStandardVersion.findFirst({ where: { id: a.versionId } });
    if (!v) throw notFound('Standard version not found', 'standard_version_not_found');
    const before = await tx.companyReportingFramework.findFirst({ where: { companyId: a.companyId, yearStart: toDate(a.yearStart) } });
    if (before?.lockedAt) throw conflict('The reporting framework of an approved year is locked', 'framework_locked');
    if (v.status === 'SUPERSEDED' && before?.versionId !== v.id) throw conflict('A superseded version cannot be chosen; choose the version that replaced it', 'version_superseded');
    if (isoDay(v.effectiveFrom) > a.yearStart || (v.effectiveTo && isoDay(v.effectiveTo) < a.yearStart)) {
      throw unprocessable(`The version is in effect from ${isoDay(v.effectiveFrom)}${v.effectiveTo ? ` to ${isoDay(v.effectiveTo)}` : ''}, not for a year starting ${a.yearStart}`, 'version_not_effective');
    }
    const data = { yearEnd: toDate(a.yearEnd), versionId: a.versionId, entitySize: a.entitySize, reason: a.reason, chosenByUserId: a.actor.userId, chosenAt: new Date() };
    let after: FrameworkRow;
    try {
      after = before ? await tx.companyReportingFramework.update({ where: { id: before.id }, data })
        : await tx.companyReportingFramework.create({ data: { organisationId: a.organisationId, companyId: a.companyId, yearStart: toDate(a.yearStart), ...data } });
    } catch (e) {
      if (dbMessage(e).includes('do not overlap')) throw conflict('This financial year overlaps another financial year of the company', 'financial_year_overlap');
      throw e;
    }
    const view = (f: FrameworkRow) => ({ yearStart: isoDay(f.yearStart), yearEnd: isoDay(f.yearEnd), versionId: f.versionId, entitySize: f.entitySize });
    await this.audit(tx, { action: before ? 'accounts.framework_changed' : 'accounts.framework_chosen', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId,
      entityType: 'company_reporting_framework', entityId: after.id, before: before ? view(before) : undefined, after: view(after), reason: a.reason });
    return frameworkView(after, v);
  }

  async listOverrides(tx: Tx, companyId: string, q: { versionId?: string; includeEnded: boolean }) {
    const rows = await tx.statutoryAccountOverride.findMany({ where: { companyId, ...(q.versionId ? { versionId: q.versionId } : {}), ...(q.includeEnded ? {} : { endedAt: null }) }, orderBy: { createdAt: 'asc' } });
    return { items: rows.map(overrideView) };
  }
  /** Places one account on a statutory line of a version, for this company, with a reason; an active override of the account is ended by it. */
  async setOverride(tx: Tx, a: Ctx & { versionId: string; accountId: string; targetKey: string; reason: string }) {
    await this.need(a.actor, a.companyId);
    if (!(await tx.account.findFirst({ where: { id: a.accountId, companyId: a.companyId }, select: { id: true } }))) throw notFound('Account not found', 'account_not_found');
    if (!(await tx.reportingStandardVersion.findFirst({ where: { id: a.versionId }, select: { id: true } }))) throw notFound('Standard version not found', 'standard_version_not_found');
    const target = await tx.statutoryLine.findFirst({ where: { versionId: a.versionId, key: a.targetKey, removed: false }, select: { kind: true } });
    if (target?.kind !== 'ACCOUNTS') throw unprocessable(`${a.targetKey} is not an accounts line of this version`, 'unknown_line', { lines: [a.targetKey] });
    const active = await tx.statutoryAccountOverride.findFirst({ where: { companyId: a.companyId, versionId: a.versionId, accountId: a.accountId, endedAt: null } });
    if (active) await tx.statutoryAccountOverride.update({ where: { id: active.id }, data: { endedAt: new Date(), endedByUserId: a.actor.userId, endedReason: `Replaced: ${a.reason}`.slice(0, 500) } });
    const o = await tx.statutoryAccountOverride.create({ data: { organisationId: a.organisationId, companyId: a.companyId, versionId: a.versionId, accountId: a.accountId, targetKey: a.targetKey, reason: a.reason, createdByUserId: a.actor.userId } });
    await this.audit(tx, { action: 'accounts.override_set', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'statutory_account_override', entityId: o.id,
      before: active ? overrideView(active) : undefined, after: overrideView(o), reason: a.reason });
    return overrideView(o);
  }
  async endOverride(tx: Tx, a: Ctx & { id: string; reason: string }) {
    await this.need(a.actor, a.companyId);
    const o = await tx.statutoryAccountOverride.findFirst({ where: { id: a.id, companyId: a.companyId } });
    if (!o) throw notFound('Override not found', 'override_not_found');
    if (o.endedAt) throw conflict('This override has already ended', 'override_ended');
    const after = await tx.statutoryAccountOverride.update({ where: { id: a.id }, data: { endedAt: new Date(), endedByUserId: a.actor.userId, endedReason: a.reason } });
    await this.audit(tx, { action: 'accounts.override_ended', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'statutory_account_override', entityId: a.id,
      before: overrideView(o), after: overrideView(after), reason: a.reason });
    return overrideView(after);
  }
}
