import { mappingProblems, type ConceptEntry } from '@uk/contracts';
import { conflict, forbidden, notFound, unprocessable, uuidv7 } from '@uk/core';
import { Prisma, type Tx } from '@uk/db';
import { auditRow } from '@uk/platform';

/**
 * V3-M1 (DEC-093): taxonomy versions and their concept maps, organisation data. A version is edited while UNVERIFIED, verified once by a person
 * who did not create it (which freezes it, in the database too), and changed only by superseding it with a copy. Nothing of the taxonomy is in
 * code: the concepts, namespaces and entry point are what the firm entered from its source.
 */
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
type VersionRow = Awaited<ReturnType<Tx['xbrlTaxonomyVersion']['findUniqueOrThrow']>>;
type EntryRow = Awaited<ReturnType<Tx['xbrlConceptMap']['findUniqueOrThrow']>>;
type Source = { url: string; provision: string; retrievedOn: string };
export interface TaxonomyActor { userId: string; kind?: string; can(permission: string): boolean | Promise<boolean> }

export const taxonomyVersionView = (v: VersionRow) => ({
  id: v.id, label: v.label, standardCode: v.standardCode, entryPoint: v.entryPoint, namespaces: v.namespaces as Record<string, string>,
  effectiveFrom: isoDay(v.effectiveFrom), effectiveTo: v.effectiveTo ? isoDay(v.effectiveTo) : null,
  source: { url: v.sourceUrl, provision: v.sourceReference, retrievedOn: isoDay(v.sourceRetrievedOn) }, notes: v.notes, status: v.status, copiedFromId: v.copiedFromId,
  createdByUserId: v.createdByUserId, createdAt: v.createdAt, verifiedByUserId: v.verifiedByUserId, verifiedAt: v.verifiedAt, verificationNotes: v.verificationNotes, supersededById: v.supersededById,
});
export const conceptEntryView = (e: EntryRow) => ({
  id: e.id, sourceKind: e.sourceKind, sourceKey: e.sourceKey, concept: e.concept, dataType: e.dataType, periodType: e.periodType, negate: e.negate, decimals: e.decimals,
  dimensions: e.dimensions as { axis: string; member: string }[], mandatory: e.mandatory,
});
const entryData = (e: ConceptEntry) => ({ sourceKind: e.sourceKind, sourceKey: e.sourceKey, concept: e.concept, dataType: e.dataType, periodType: e.periodType, negate: e.negate,
  decimals: e.decimals, dimensions: e.dimensions as Prisma.InputJsonValue, mandatory: e.mandatory });

export class TaxonomyService {
  constructor(private readonly opts: { captureDeviceMetadata?: boolean } = {}) {}
  private audit(tx: Tx, e: Parameters<typeof auditRow>[0]) { return tx.auditEvent.createMany({ data: [auditRow(e, this.opts.captureDeviceMetadata)] }); }
  private async need(actor: TaxonomyActor, permission: string) {
    if (actor.kind && actor.kind !== 'USER') throw forbidden('Only a person can change the taxonomy mapping', 'ai_cannot_write');
    if (!(await actor.can(permission))) throw forbidden(`Requires permission ${permission}`, 'permission_denied');
  }
  private async version(tx: Tx, id: string) {
    const v = await tx.xbrlTaxonomyVersion.findFirst({ where: { id } });
    if (!v) throw notFound('Taxonomy version not found', 'taxonomy_version_not_found');
    return v;
  }
  private async editable(tx: Tx, id: string) {
    const v = await this.version(tx, id);
    if (v.status !== 'UNVERIFIED') throw conflict('A verified taxonomy version is frozen; supersede it with a new version', 'version_frozen');
    return v;
  }
  private mapDb(e: unknown): never {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('This source is already mapped in the version', 'entry_exists');
    if (String((e as Error).message).includes('frozen')) throw conflict('A verified taxonomy version is frozen; supersede it with a new version', 'version_frozen');
    throw e;
  }

  async list(tx: Tx, q: { standardCode?: string; includeSuperseded?: boolean }) {
    const rows = await tx.xbrlTaxonomyVersion.findMany({ where: { ...(q.standardCode ? { standardCode: q.standardCode } : {}), ...(q.includeSuperseded ? {} : { status: { not: 'SUPERSEDED' } }) },
      orderBy: [{ standardCode: 'asc' }, { effectiveFrom: 'asc' }, { createdAt: 'asc' }] });
    return { items: rows.map(taxonomyVersionView) };
  }
  /** The version, its entries (by kind and key) and what would stop its verification. */
  async get(tx: Tx, id: string) {
    const v = await this.version(tx, id);
    const entries = (await tx.xbrlConceptMap.findMany({ where: { versionId: id }, orderBy: [{ sourceKind: 'asc' }, { sourceKey: 'asc' }] })).map(conceptEntryView);
    return { ...taxonomyVersionView(v), entries, problems: mappingProblems({ namespaces: v.namespaces as Record<string, string> }, entries as ConceptEntry[]) };
  }

  async create(tx: Tx, a: { organisationId: string; actor: TaxonomyActor; label: string; standardCode: string; entryPoint: string; namespaces: Record<string, string>; effectiveFrom: string; effectiveTo?: string; source: Source; notes?: string; copyFromVersionId?: string }) {
    await this.need(a.actor, 'ixbrl:rules-manage');
    const from = a.copyFromVersionId ? await this.version(tx, a.copyFromVersionId) : null;
    if (from && from.standardCode !== a.standardCode) throw unprocessable('A copy tags the same standard as its original', 'standard_mismatch');
    const v = await tx.xbrlTaxonomyVersion.create({ data: { organisationId: a.organisationId, label: a.label, standardCode: a.standardCode, entryPoint: a.entryPoint, namespaces: a.namespaces,
      effectiveFrom: toDate(a.effectiveFrom), effectiveTo: a.effectiveTo ? toDate(a.effectiveTo) : null, sourceUrl: a.source.url, sourceReference: a.source.provision,
      sourceRetrievedOn: toDate(a.source.retrievedOn), notes: a.notes ?? null, copiedFromId: from?.id ?? null, createdByUserId: a.actor.userId } });
    if (from) await this.copyEntries(tx, a.organisationId, from.id, v.id);
    await this.audit(tx, { action: 'ixbrl.taxonomy_version_created', organisationId: a.organisationId, actorUserId: a.actor.userId, entityType: 'xbrl_taxonomy_version', entityId: v.id, after: taxonomyVersionView(v) });
    return this.get(tx, v.id);
  }
  private async copyEntries(tx: Tx, organisationId: string, fromId: string, toId: string) {
    const rows = await tx.xbrlConceptMap.findMany({ where: { versionId: fromId } });
    if (rows.length) await tx.xbrlConceptMap.createMany({ data: rows.map((e) => ({ organisationId, versionId: toId, ...entryData(conceptEntryView(e) as ConceptEntry) })) });
  }
  async update(tx: Tx, a: { organisationId: string; actor: TaxonomyActor; id: string; label?: string; entryPoint?: string; namespaces?: Record<string, string>; effectiveFrom?: string; effectiveTo?: string | null; source?: Source; notes?: string | null }) {
    await this.need(a.actor, 'ixbrl:rules-manage');
    const before = await this.editable(tx, a.id);
    const from = a.effectiveFrom ?? isoDay(before.effectiveFrom), to = a.effectiveTo === undefined ? (before.effectiveTo ? isoDay(before.effectiveTo) : null) : a.effectiveTo;
    if (to && to < from) throw unprocessable('effectiveTo cannot precede effectiveFrom', 'invalid_date');
    let after: VersionRow;
    try {
      after = await tx.xbrlTaxonomyVersion.update({ where: { id: a.id }, data: { ...(a.label !== undefined ? { label: a.label } : {}), ...(a.entryPoint !== undefined ? { entryPoint: a.entryPoint } : {}),
        ...(a.namespaces !== undefined ? { namespaces: a.namespaces } : {}), effectiveFrom: toDate(from), effectiveTo: to ? toDate(to) : null,
        ...(a.source ? { sourceUrl: a.source.url, sourceReference: a.source.provision, sourceRetrievedOn: toDate(a.source.retrievedOn) } : {}), ...(a.notes !== undefined ? { notes: a.notes } : {}) } });
    } catch (e) { this.mapDb(e); }
    await this.audit(tx, { action: 'ixbrl.taxonomy_version_changed', organisationId: a.organisationId, actorUserId: a.actor.userId, entityType: 'xbrl_taxonomy_version', entityId: a.id,
      before: taxonomyVersionView(before), after: taxonomyVersionView(after) });
    return this.get(tx, a.id);
  }

  // ───── Entries (only while UNVERIFIED; the database proves it again) ─────
  async addEntry(tx: Tx, a: { organisationId: string; actor: TaxonomyActor; versionId: string; entry: ConceptEntry }) {
    await this.need(a.actor, 'ixbrl:rules-manage');
    await this.editable(tx, a.versionId);
    let e: EntryRow;
    try { e = await tx.xbrlConceptMap.create({ data: { organisationId: a.organisationId, versionId: a.versionId, ...entryData(a.entry) } }); } catch (err) { this.mapDb(err); }
    await this.audit(tx, { action: 'ixbrl.concept_mapped', organisationId: a.organisationId, actorUserId: a.actor.userId, entityType: 'xbrl_concept_map', entityId: e.id, after: { versionId: a.versionId, ...conceptEntryView(e) } });
    return conceptEntryView(e);
  }
  async replaceEntry(tx: Tx, a: { organisationId: string; actor: TaxonomyActor; versionId: string; entryId: string; entry: ConceptEntry }) {
    await this.need(a.actor, 'ixbrl:rules-manage');
    await this.editable(tx, a.versionId);
    const before = await tx.xbrlConceptMap.findFirst({ where: { id: a.entryId, versionId: a.versionId } });
    if (!before) throw notFound('Mapping entry not found', 'entry_not_found');
    let e: EntryRow;
    try { e = await tx.xbrlConceptMap.update({ where: { id: before.id }, data: entryData(a.entry) }); } catch (err) { this.mapDb(err); }
    await this.audit(tx, { action: 'ixbrl.concept_mapping_changed', organisationId: a.organisationId, actorUserId: a.actor.userId, entityType: 'xbrl_concept_map', entityId: e.id,
      before: conceptEntryView(before), after: conceptEntryView(e) });
    return conceptEntryView(e);
  }
  async removeEntry(tx: Tx, a: { organisationId: string; actor: TaxonomyActor; versionId: string; entryId: string }) {
    await this.need(a.actor, 'ixbrl:rules-manage');
    await this.editable(tx, a.versionId);
    const before = await tx.xbrlConceptMap.findFirst({ where: { id: a.entryId, versionId: a.versionId } });
    if (!before) throw notFound('Mapping entry not found', 'entry_not_found');
    try { await tx.xbrlConceptMap.delete({ where: { id: before.id } }); } catch (err) { this.mapDb(err); }
    await this.audit(tx, { action: 'ixbrl.concept_mapping_removed', organisationId: a.organisationId, actorUserId: a.actor.userId, entityType: 'xbrl_concept_map', entityId: before.id, before: conceptEntryView(before) });
    return this.get(tx, a.versionId);
  }

  // ───── Verification and supersession ─────
  async verify(tx: Tx, a: { organisationId: string; actor: TaxonomyActor; id: string; notes: string }) {
    await this.need(a.actor, 'ixbrl:rule-verify');
    const v = await this.version(tx, a.id);
    if (v.status === 'VERIFIED') throw conflict('This version is already verified', 'already_verified');
    if (v.status === 'SUPERSEDED') throw conflict('A superseded version cannot be verified', 'version_superseded');
    if (v.createdByUserId === a.actor.userId) throw forbidden('A taxonomy version must be verified by someone other than the person who created it', 'self_verification_not_allowed');
    const current = await this.get(tx, a.id);
    if (current.problems.length) throw unprocessable('The mapping is not consistent and cannot be verified', 'version_inconsistent', { problems: current.problems });
    await tx.xbrlTaxonomyVersion.update({ where: { id: a.id }, data: { status: 'VERIFIED', verifiedByUserId: a.actor.userId, verifiedAt: new Date(), verificationNotes: a.notes.trim() } });
    await this.audit(tx, { action: 'ixbrl.taxonomy_version_verified', organisationId: a.organisationId, actorUserId: a.actor.userId, entityType: 'xbrl_taxonomy_version', entityId: a.id,
      before: { status: v.status }, after: { status: 'VERIFIED', entries: current.entries.length }, reason: a.notes.trim() });
    return this.get(tx, a.id);
  }
  /** A change to a verified version: a new UNVERIFIED copy with the same entries, the old one SUPERSEDED, in one transaction. */
  async supersede(tx: Tx, a: { organisationId: string; actor: TaxonomyActor; id: string; label: string; effectiveFrom: string; effectiveTo?: string; source: Source; notes?: string; reason: string }) {
    await this.need(a.actor, 'ixbrl:rules-manage');
    const old = await this.version(tx, a.id);
    if (old.status === 'UNVERIFIED') throw conflict('An unverified version is edited, not superseded', 'version_unverified');
    if (old.status === 'SUPERSEDED') throw conflict('This version was already superseded', 'version_superseded');
    const id = uuidv7();
    await tx.xbrlTaxonomyVersion.update({ where: { id: old.id }, data: { status: 'SUPERSEDED', supersededById: id } });
    await tx.xbrlTaxonomyVersion.create({ data: { id, organisationId: a.organisationId, label: a.label, standardCode: old.standardCode, entryPoint: old.entryPoint, namespaces: old.namespaces as Prisma.InputJsonValue,
      effectiveFrom: toDate(a.effectiveFrom), effectiveTo: a.effectiveTo ? toDate(a.effectiveTo) : null, sourceUrl: a.source.url, sourceReference: a.source.provision,
      sourceRetrievedOn: toDate(a.source.retrievedOn), notes: a.notes ?? null, copiedFromId: old.id, createdByUserId: a.actor.userId } });
    await this.copyEntries(tx, a.organisationId, old.id, id);
    await this.audit(tx, { action: 'ixbrl.taxonomy_version_superseded', organisationId: a.organisationId, actorUserId: a.actor.userId, entityType: 'xbrl_taxonomy_version', entityId: old.id,
      before: { status: old.status }, after: { status: 'SUPERSEDED', supersededById: id }, reason: a.reason.trim() });
    return this.get(tx, id);
  }
}
