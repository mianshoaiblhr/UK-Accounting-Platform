import { Inject, Injectable } from '@nestjs/common';
import type { EvidenceEntityType, EvidenceKind } from '@uk/contracts';
import { conflict, notFound, unprocessable } from '@uk/core';
import { Prisma, type Database, type Tx } from '@uk/db';
import { AuditService } from '../audit/audit.service';
import { DB } from '../common/tokens';
import type { OrgAccess } from '../common/types';

/**
 * The evidence graph API (cross-platform §6). A link joins two entities of the same company. Both ends must be visible to the caller
 * through each end's OWN rules (document visibility, task/workflow/contact/period permissions ...): an entity the caller cannot see is
 * reported as not found, and links to entities the caller cannot see are never listed. Links are immutable; revoking records who and why.
 */
@Injectable()
export class EvidenceService {
  constructor(@Inject(DB) private readonly db: Database, private readonly audit: AuditService) {}

  private t<T>(org: OrgAccess, fn: (tx: Tx) => Promise<T>) { return this.db.tenant({ organisationId: org.organisationId, userId: org.userId }, fn); }

  /**
   * One resolver per entity type: the entity's company and whether the caller may read it. Later versions add their types here
   * (journal, bank_transaction, report, tax_return, filing ...) next to the registry in @uk/contracts and the database check constraint.
   */
  private async resolve(org: OrgAccess, tx: Tx, type: EvidenceEntityType, id: string): Promise<{ companyId: string | null } | null> {
    const readable = async (perm: Parameters<typeof org.access.can>[0], companyId: string | null) => (await org.access.can(perm, { companyId })) ? { companyId } : null;
    switch (type) {
      case 'document': {
        const d = await tx.document.findUnique({ where: { id }, select: { id: true, companyId: true, visibility: true, createdByUserId: true } });
        return d && (await org.access.canReadDocument(d)) ? { companyId: d.companyId } : null;
      }
      case 'document_version': {
        const v = await tx.documentVersion.findUnique({ where: { id }, select: { document: { select: { id: true, companyId: true, visibility: true, createdByUserId: true } } } });
        return v && (await org.access.canReadDocument(v.document)) ? { companyId: v.document.companyId } : null;
      }
      case 'task': { const x = await tx.task.findUnique({ where: { id }, select: { companyId: true } }); return x ? readable('task:read', x.companyId) : null; }
      case 'workflow_instance': { const x = await tx.workflowInstance.findUnique({ where: { id }, select: { companyId: true } }); return x ? readable('workflow:read', x.companyId) : null; }
      case 'ai_proposal': { const x = await tx.aiProposal.findUnique({ where: { id }, select: { companyId: true } }); return x ? readable('ai:use', x.companyId) : null; }
      case 'contact': { const x = await tx.contact.findUnique({ where: { id }, select: { companyId: true } }); return x ? readable('contact:read', x.companyId) : null; }
      case 'company': { const x = await tx.company.findUnique({ where: { id }, select: { id: true } }); return x ? readable('company:read', x.id) : null; }
      case 'journal': { const x = await tx.journal.findUnique({ where: { id }, select: { companyId: true } }); return x ? readable('ledger:read', x.companyId) : null; }
      case 'accounting_period': { const x = await tx.accountingPeriod.findUnique({ where: { id }, select: { companyId: true } }); return x ? readable('period:read', x.companyId) : null; }
    }
  }

  async create(org: OrgAccess, input: { sourceType: EvidenceEntityType; sourceId: string; targetType: EvidenceEntityType; targetId: string; kind: EvidenceKind; note?: string }) {
    if (input.sourceType === input.targetType && input.sourceId === input.targetId) throw unprocessable('An entity cannot be linked to itself', 'evidence_self_link');
    return this.t(org, async (tx) => {
      const src = await this.resolve(org, tx, input.sourceType, input.sourceId);
      const tgt = await this.resolve(org, tx, input.targetType, input.targetId);
      if (!src || !tgt) throw unprocessable('The source or the target was not found', 'unknown_evidence_entity'); // never says which, nor why
      if (src.companyId && tgt.companyId && src.companyId !== tgt.companyId) throw unprocessable('Evidence can only link entities of the same company', 'evidence_company_mismatch');
      const companyId = src.companyId ?? tgt.companyId;
      await org.access.requireResource('evidence:manage', companyId, 'Not found');
      try {
        const link = await tx.evidenceLink.create({ data: { organisationId: org.organisationId, companyId, sourceType: input.sourceType, sourceId: input.sourceId, targetType: input.targetType, targetId: input.targetId, kind: input.kind, note: input.note, createdByUserId: org.userId } });
        await this.audit.record({ action: 'evidence_link.created', organisationId: org.organisationId, actorUserId: org.userId, companyId, entityType: 'evidence_link', entityId: link.id,
          after: { source: `${input.sourceType}:${input.sourceId}`, target: `${input.targetType}:${input.targetId}`, kind: input.kind } }, tx);
        return link;
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('These entities are already linked in this way', 'link_exists');
        throw e;
      }
    });
  }

  /** Links of one entity. The entity itself must be visible; links whose other end the caller cannot see are omitted. */
  async list(org: OrgAccess, q: { entityType: EvidenceEntityType; entityId: string; direction: 'out' | 'in' | 'both'; includeRevoked?: boolean; limit: number }) {
    const scope = await org.access.companyWhere('evidence:read');
    return this.t(org, async (tx) => {
      if (!(await this.resolve(org, tx, q.entityType, q.entityId))) throw notFound('Entity not found');
      const ends = [
        ...(q.direction !== 'in' ? [{ sourceType: q.entityType, sourceId: q.entityId }] : []),
        ...(q.direction !== 'out' ? [{ targetType: q.entityType, targetId: q.entityId }] : []),
      ];
      const rows = await tx.evidenceLink.findMany({ where: { AND: [scope, { OR: ends }, q.includeRevoked ? {} : { revokedAt: null }] }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: q.limit });
      const items = [];
      for (const l of rows) {
        const outgoing = l.sourceType === q.entityType && l.sourceId === q.entityId;
        const other = outgoing ? { type: l.targetType, id: l.targetId } : { type: l.sourceType, id: l.sourceId };
        if (await this.resolve(org, tx, other.type as EvidenceEntityType, other.id)) items.push({ ...l, direction: outgoing ? 'out' as const : 'in' as const });
      }
      return { items };
    });
  }

  async revoke(org: OrgAccess, id: string, reason: string) {
    return this.t(org, async (tx) => {
      const l = await tx.evidenceLink.findUnique({ where: { id } });
      if (!l) throw notFound('Evidence link not found');
      await org.access.requireResource('evidence:manage', l.companyId, 'Evidence link not found');
      const a = await this.resolve(org, tx, l.sourceType as EvidenceEntityType, l.sourceId), b = await this.resolve(org, tx, l.targetType as EvidenceEntityType, l.targetId);
      if (!a || !b) throw notFound('Evidence link not found');
      if (l.revokedAt) throw conflict('The link is already revoked', 'link_revoked');
      const r = await tx.evidenceLink.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date(), revokedByUserId: org.userId, revokedReason: reason } });
      if (r.count !== 1) throw conflict('The link is already revoked', 'link_revoked');
      await this.audit.record({ action: 'evidence_link.revoked', organisationId: org.organisationId, actorUserId: org.userId, companyId: l.companyId, entityType: 'evidence_link', entityId: id, reason }, tx);
      return tx.evidenceLink.findUniqueOrThrow({ where: { id } });
    });
  }
}
