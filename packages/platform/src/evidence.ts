import type { EvidenceEntityType, EvidenceKind } from '@uk/contracts';
import type { Tx } from '@uk/db';

/**
 * Evidence graph writer used INSIDE a caller's transaction (task attachments, workflow evidence, later: journals, reports, filings).
 * The caller has already authorised the action and validated both ends; this only records the link, atomically with the change that
 * caused it. Duplicates of an active link are ignored. Links are never edited or deleted - only revoked (database trigger).
 */
export interface EvidenceEnd { type: EvidenceEntityType; id: string }

export async function recordEvidenceLink(tx: Tx, a: {
  organisationId: string; companyId: string | null; source: EvidenceEnd; target: EvidenceEnd; kind: EvidenceKind; note?: string; createdByUserId?: string | null;
}): Promise<boolean> {
  const r = await tx.evidenceLink.createMany({ data: [{
    organisationId: a.organisationId, companyId: a.companyId, sourceType: a.source.type, sourceId: a.source.id, targetType: a.target.type, targetId: a.target.id,
    kind: a.kind, note: a.note, createdByUserId: a.createdByUserId ?? null,
  }], skipDuplicates: true });
  return r.count === 1;
}

/** Revokes the active link(s) between two entities (optionally one kind). Returns how many were revoked. */
export async function revokeEvidenceLinks(tx: Tx, a: { source: EvidenceEnd; target: EvidenceEnd; kind?: EvidenceKind; revokedByUserId: string | null; reason: string }): Promise<number> {
  const r = await tx.evidenceLink.updateMany({
    where: { sourceType: a.source.type, sourceId: a.source.id, targetType: a.target.type, targetId: a.target.id, ...(a.kind ? { kind: a.kind } : {}), revokedAt: null },
    data: { revokedAt: new Date(), revokedByUserId: a.revokedByUserId, revokedReason: a.reason },
  });
  return r.count;
}
