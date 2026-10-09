import { Inject, Injectable } from '@nestjs/common';
import { ALLOWED_UPLOAD_TYPES, EVIDENCE_DEFAULT_RETENTION_YEARS, Events, JobTypes, isDocumentType, type Permission } from '@uk/contracts';
import { changeSet, publishEvent } from '@uk/platform';
import { badRequest, conflict, notFound, unprocessable, uuidv7, type AppConfig } from '@uk/core';
import type { StoragePort } from '@uk/adapters';
import { Prisma, type Database, type Document, type Tx } from '@uk/db';
import { loadAccess } from '../common/access';
import type { JobProducer } from '@uk/jobs';
import { AuditService } from '../audit/audit.service';
import { CONFIG, DB, JOBS, STORAGE } from '../common/tokens';
import type { OrgAccess } from '../common/types';

const PRESIGN_SECONDS = 300;

@Injectable()
export class DocumentsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(JOBS) private readonly jobs: JobProducer,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  private t<T>(org: OrgAccess, fn: (tx: Tx) => Promise<T>) { return this.db.tenant({ organisationId: org.organisationId, userId: org.userId }, fn); }

  private validateFile(contentType: string, sizeBytes: number) {
    if (!(ALLOWED_UPLOAD_TYPES as readonly string[]).includes(contentType)) throw unprocessable(`Content type ${contentType} is not allowed`, 'content_type_not_allowed');
    if (sizeBytes > this.config.MAX_UPLOAD_BYTES) throw unprocessable('File too large', 'file_too_large');
  }

  private key(orgId: string, docId: string, versionNo: number, versionId: string) {
    return `org/${orgId}/doc/${docId}/v${versionNo}-${versionId}`;
  }

  private async uploadInstructions(org: OrgAccess, documentId: string, v: { id: string; storageKey: string; contentType: string }) {
    const presigned = await this.storage.presignUpload(v.storageKey, v.contentType, PRESIGN_SECONDS);
    if (presigned) return { ...presigned, via: 'presigned' as const, expiresInSeconds: PRESIGN_SECONDS };
    return {
      method: 'PUT' as const, via: 'api' as const, headers: { 'Content-Type': v.contentType },
      url: `/api/v1/organisations/${org.organisationId}/documents/${documentId}/versions/${v.id}/content`, expiresInSeconds: PRESIGN_SECONDS,
    };
  }

  /** Reference-data and placement checks with clear errors (the database enforces the same rules with triggers). */
  private async assertPlacement(tx: Tx, p: { documentClass?: string; companyId: string | null; folderId?: string | null; periodId?: string | null }) {
    if (p.documentClass !== undefined && !isDocumentType(p.documentClass) && !(await tx.documentType.findUnique({ where: { code: p.documentClass } }))) {
      throw unprocessable(`Unknown document type ${p.documentClass}`, 'unknown_document_type');
    }
    if (p.folderId) {
      const f = await tx.documentFolder.findUnique({ where: { id: p.folderId } });
      if (!f) throw unprocessable('Folder not found', 'unknown_folder');
      if (f.companyId !== p.companyId) throw unprocessable('A document can only be filed in a folder of its own company', 'folder_company_mismatch');
    }
    if (p.periodId) {
      if (!p.companyId) throw unprocessable('Only company documents can be linked to an accounting period', 'period_requires_company');
      const per = await tx.accountingPeriod.findUnique({ where: { id: p.periodId } });
      if (!per || per.companyId !== p.companyId) throw unprocessable('Accounting period not found for this company', 'unknown_period');
    }
  }

  async create(org: OrgAccess, input: { name: string; companyId?: string; contentType: string; sizeBytes: number; documentClass: string; folderId?: string; periodId?: string; description?: string; documentDate?: string; reference?: string; labels?: string[]; metadata?: Record<string, string | number | boolean>; visibility: 'STANDARD' | 'RESTRICTED' }) {
    this.validateFile(input.contentType, input.sizeBytes);
    await org.access.requireResource('document:upload', input.companyId ?? null, 'Company not found');
    const documentId = uuidv7(), versionId = uuidv7();
    const storageKey = this.key(org.organisationId, documentId, 1, versionId);
    const out = await this.t(org, async (tx) => {
      if (input.companyId && !(await tx.company.findUnique({ where: { id: input.companyId } }))) throw notFound('Company not found');
      await this.assertPlacement(tx, { documentClass: input.documentClass, companyId: input.companyId ?? null, folderId: input.folderId, periodId: input.periodId });
      const document = await tx.document.create({
        data: { id: documentId, organisationId: org.organisationId, companyId: input.companyId, name: input.name, documentClass: input.documentClass, createdByUserId: org.userId,
          folderId: input.folderId, periodId: input.periodId, description: input.description, documentDate: input.documentDate ? new Date(input.documentDate) : undefined,
          reference: input.reference, labels: input.labels ?? [], metadata: input.metadata ?? {}, visibility: input.visibility },
      });
      const version = await tx.documentVersion.create({
        data: { id: versionId, organisationId: org.organisationId, documentId, versionNo: 1, storageKey, contentType: input.contentType, sizeBytes: input.sizeBytes, createdByUserId: org.userId },
      });
      await this.audit.record({ action: 'document.created', organisationId: org.organisationId, actorUserId: org.userId, companyId: input.companyId ?? null, entityType: 'document', entityId: documentId,
        after: { name: input.name, documentClass: input.documentClass, folderId: input.folderId ?? null, periodId: input.periodId ?? null, visibility: input.visibility }, metadata: { versionId } }, tx);
      return { document, version };
    });
    return { ...out, upload: await this.uploadInstructions(org, documentId, out.version) };
  }

  async newVersion(org: OrgAccess, documentId: string, input: { contentType: string; sizeBytes: number }) {
    this.validateFile(input.contentType, input.sizeBytes);
    const doc = await this.getDocument(org, documentId, 'document:upload');
    if (doc.status === 'ARCHIVED') throw conflict('Document is archived', 'document_archived');
    if (doc.evidenceLockedAt) throw conflict('This document is locked filing evidence and accepts no new versions', 'evidence_locked');
    const versionId = uuidv7();
    const version = await this.t(org, async (tx) => {
      const last = await tx.documentVersion.aggregate({ where: { documentId }, _max: { versionNo: true } });
      const versionNo = (last._max.versionNo ?? 0) + 1;
      const v = await tx.documentVersion.create({
        data: { id: versionId, organisationId: org.organisationId, documentId, versionNo, storageKey: this.key(org.organisationId, documentId, versionNo, versionId), contentType: input.contentType, sizeBytes: input.sizeBytes, createdByUserId: org.userId },
      });
      await this.audit.record({ action: 'document.version_created', organisationId: org.organisationId, actorUserId: org.userId, companyId: doc.companyId, entityType: 'document', entityId: documentId, metadata: { versionId, versionNo } }, tx);
      return v;
    });
    return { version, upload: await this.uploadInstructions(org, documentId, version) };
  }

  /**
   * Loads a document the caller may act on with `perm` (permission is evaluated for the document's own company). A document the
   * caller may not see - no access to the company, or RESTRICTED without a grant - is a 404 for every operation (ADR-32).
   */
  private async getDocument(org: OrgAccess, documentId: string, perm: Permission): Promise<Document> {
    const d = await this.t(org, (tx) => tx.document.findUnique({ where: { id: documentId } }));
    if (!d) throw notFound('Document not found');
    if (d.companyId) await org.access.requireResource('document:read', d.companyId, 'Document not found');
    if (!(await org.access.canReadDocument(d))) throw notFound('Document not found');
    if (perm !== 'document:read') await org.access.requireResource(perm, d.companyId, 'Document not found');
    else if (!d.companyId) await org.access.requireResource(perm, null, 'Document not found');
    return d;
  }

  private async getVersion(org: OrgAccess, documentId: string, versionId: string, perm: Permission) {
    await this.getDocument(org, documentId, perm);
    const v = await this.t(org, (tx) => tx.documentVersion.findFirst({ where: { id: versionId, documentId } }));
    if (!v) throw notFound('Document version not found');
    return v;
  }

  /** Direct-through-API upload (local driver / small files). S3 deployments upload with the presigned URL. */
  async uploadContent(org: OrgAccess, documentId: string, versionId: string, body: Buffer) {
    const v = await this.getVersion(org, documentId, versionId, 'document:upload');
    if (v.status !== 'PENDING_UPLOAD') throw conflict('Content was already uploaded for this version', 'already_uploaded');
    if (!Buffer.isBuffer(body) || body.length === 0) throw badRequest('Empty upload body', 'empty_body');
    if (body.length !== v.sizeBytes) throw unprocessable('Uploaded size does not match declared size', 'size_mismatch');
    await this.storage.putObject(v.storageKey, body, v.contentType);
    return this.markUploaded(org, v.id);
  }

  async complete(org: OrgAccess, documentId: string, versionId: string) {
    const v = await this.getVersion(org, documentId, versionId, 'document:upload');
    if (v.status !== 'PENDING_UPLOAD' && v.status !== 'UPLOADED') return v; // idempotent
    const head = await this.storage.headObject(v.storageKey);
    if (!head) throw unprocessable('No uploaded content found for this version', 'upload_missing');
    if (head.sizeBytes !== v.sizeBytes) throw unprocessable('Uploaded size does not match declared size', 'size_mismatch');
    return this.markUploaded(org, v.id);
  }

  private async markUploaded(org: OrgAccess, versionId: string) {
    const v = await this.t(org, async (tx) => {
      const moved = await tx.documentVersion.updateMany({ where: { id: versionId, status: 'PENDING_UPLOAD' }, data: { status: 'UPLOADED' } });
      const ver = await tx.documentVersion.findUniqueOrThrow({ where: { id: versionId }, include: { document: { select: { companyId: true } } } });
      if (moved.count === 1) {
        await publishEvent(tx, Events.documentUploaded, { aggregateId: ver.id, organisationId: org.organisationId, actorUserId: org.userId,
          payload: { documentId: ver.documentId, versionId: ver.id, companyId: ver.document.companyId, contentType: ver.contentType, sizeBytes: ver.sizeBytes } });
      }
      const { document: _d, ...plain } = ver;
      return { version: plain, companyId: ver.document.companyId };
    });
    await this.jobs.enqueue(JobTypes.documentProcess, { documentVersionId: versionId }, {
      organisationId: org.organisationId, userId: org.userId, companyId: v.companyId ?? undefined, idempotencyKey: `docproc:${versionId}`,
    });
    return v.version;
  }

  async list(org: OrgAccess, q: { limit: number; cursor?: string; companyId?: string; folderId?: string; periodId?: string; documentClass?: string; visibility?: string; q?: string; status?: string; evidenceLocked?: boolean }) {
    const visible = await org.access.documentWhere();
    const where: Prisma.DocumentWhereInput = { AND: [
      visible,
      q.companyId ? { companyId: q.companyId } : {}, q.folderId ? { folderId: q.folderId } : {}, q.periodId ? { periodId: q.periodId } : {},
      q.documentClass ? { documentClass: q.documentClass } : {}, q.visibility ? { visibility: q.visibility } : {},
      q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {}, q.status ? { status: q.status as 'ACTIVE' | 'ARCHIVED' } : {},
      q.evidenceLocked === undefined ? {} : q.evidenceLocked ? { evidenceLockedAt: { not: null } } : { evidenceLockedAt: null },
    ] };
    const rows = await this.t(org, (tx) => tx.document.findMany({
      where, orderBy: { id: 'desc' }, take: q.limit + 1,
      include: { versions: { orderBy: { versionNo: 'desc' }, take: 1 } },
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    }));
    return { items: rows.slice(0, q.limit), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null };
  }

  async get(org: OrgAccess, documentId: string) {
    await this.getDocument(org, documentId, 'document:read');
    return this.t(org, (tx) => tx.document.findUniqueOrThrow({ where: { id: documentId }, include: { versions: { orderBy: { versionNo: 'desc' } } } }));
  }

  async archive(org: OrgAccess, documentId: string, reason?: string) {
    const d = await this.getDocument(org, documentId, 'document:archive');
    if (d.evidenceLockedAt) throw conflict('Locked filing evidence cannot be archived', 'evidence_locked');
    if (d.legalHold) throw conflict('Document is under legal hold', 'legal_hold');
    return this.t(org, async (tx) => {
      const r = await tx.document.update({ where: { id: documentId }, data: { status: 'ARCHIVED' } });
      await this.audit.record({ action: 'document.archived', organisationId: org.organisationId, actorUserId: org.userId, companyId: d.companyId, entityType: 'document', entityId: documentId, before: { status: d.status }, after: { status: 'ARCHIVED' }, reason }, tx);
      return r;
    });
  }

  async downloadLink(org: OrgAccess, documentId: string, versionId: string) {
    const v = await this.getVersion(org, documentId, versionId, 'document:read');
    if (v.status !== 'AVAILABLE') throw conflict(`Document version is ${v.status}; only AVAILABLE versions can be downloaded`, 'document_not_available');
    const doc = await this.getDocument(org, documentId, 'document:read');
    const url = (await this.storage.presignDownload(v.storageKey, doc.name, PRESIGN_SECONDS))
      ?? `/api/v1/organisations/${org.organisationId}/documents/${documentId}/versions/${versionId}/content`;
    await this.audit.record({ action: 'document.download_link_issued', organisationId: org.organisationId, actorUserId: org.userId, companyId: doc.companyId, entityType: 'document_version', entityId: versionId });
    return { url, expiresInSeconds: PRESIGN_SECONDS, sha256: v.sha256 };
  }

  /** Streams content through the API (local driver). Same authorization and AVAILABLE gate as presigned links. */
  async readContent(org: OrgAccess, documentId: string, versionId: string) {
    const v = await this.getVersion(org, documentId, versionId, 'document:read');
    if (v.status !== 'AVAILABLE') throw conflict('Document version is not available', 'document_not_available');
    const doc = await this.getDocument(org, documentId, 'document:read');
    await this.audit.record({ action: 'document.downloaded', organisationId: org.organisationId, actorUserId: org.userId, companyId: doc.companyId, entityType: 'document_version', entityId: versionId });
    return { data: await this.storage.getObject(v.storageKey), contentType: v.contentType, filename: doc.name };
  }

  // ───────── metadata ─────────
  async update(org: OrgAccess, documentId: string, input: { name?: string; documentClass?: string; folderId?: string | null; periodId?: string | null; description?: string | null; documentDate?: string | null; reference?: string | null; labels?: string[]; metadata?: Record<string, string | number | boolean>; visibility?: 'STANDARD' | 'RESTRICTED'; reason?: string }) {
    const d = await this.getDocument(org, documentId, 'document:upload');
    if (d.evidenceLockedAt) throw conflict('Locked filing evidence cannot be changed', 'evidence_locked');
    if (d.status === 'ARCHIVED') throw conflict('Document is archived', 'document_archived');
    if (input.visibility && input.visibility !== d.visibility && d.visibility === 'RESTRICTED') {
      await org.access.requireResource('document:confidential', d.companyId, 'Document not found'); // only confidential-document managers can relax a restriction
    }
    const next = { folderId: input.folderId === undefined ? d.folderId : input.folderId, periodId: input.periodId === undefined ? d.periodId : input.periodId };
    return this.t(org, async (tx) => {
      await this.assertPlacement(tx, { documentClass: input.documentClass, companyId: d.companyId, folderId: next.folderId, periodId: next.periodId });
      const after = await tx.document.update({ where: { id: documentId }, data: {
        name: input.name, documentClass: input.documentClass, folderId: input.folderId, periodId: input.periodId,
        description: input.description, documentDate: input.documentDate === undefined ? undefined : input.documentDate === null ? null : new Date(input.documentDate),
        reference: input.reference, labels: input.labels, metadata: input.metadata, visibility: input.visibility } });
      const view = (x: Document) => ({ ...x, documentDate: x.documentDate ? x.documentDate.toISOString().slice(0, 10) : null }) as unknown as Record<string, unknown>;
      await this.audit.record({ action: 'document.updated', organisationId: org.organisationId, actorUserId: org.userId, companyId: d.companyId, entityType: 'document', entityId: documentId,
        ...changeSet(view(d), view(after), ['name', 'documentClass', 'folderId', 'periodId', 'description', 'documentDate', 'reference', 'labels', 'metadata', 'visibility']), reason: input.reason }, tx);
      return after;
    });
  }

  // ───────── restricted documents: explicit grants ─────────
  async listAccess(org: OrgAccess, documentId: string) {
    const d = await this.getDocument(org, documentId, 'document:confidential');
    return { items: await this.t(org, (tx) => tx.documentAccess.findMany({ where: { documentId: d.id }, orderBy: { createdAt: 'asc' } })) };
  }

  async grantAccess(org: OrgAccess, documentId: string, userId: string) {
    const d = await this.getDocument(org, documentId, 'document:confidential');
    const target = await loadAccess(this.db, org.organisationId, userId);
    if (!target || !(await target.access.can('document:read', { companyId: d.companyId }))) throw unprocessable('The user is not an active member with access to this company', 'invalid_grantee');
    return this.t(org, async (tx) => {
      try {
        const g = await tx.documentAccess.create({ data: { organisationId: org.organisationId, documentId, userId, grantedByUserId: org.userId } });
        await this.audit.record({ action: 'document.access_granted', organisationId: org.organisationId, actorUserId: org.userId, companyId: d.companyId, entityType: 'document', entityId: documentId, metadata: { userId } }, tx);
        return g;
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('The user already has access', 'access_exists');
        throw e;
      }
    });
  }

  async revokeAccess(org: OrgAccess, documentId: string, userId: string) {
    const d = await this.getDocument(org, documentId, 'document:confidential');
    await this.t(org, async (tx) => {
      const r = await tx.documentAccess.deleteMany({ where: { documentId, userId } });
      if (!r.count) throw notFound('Access grant not found');
      await this.audit.record({ action: 'document.access_revoked', organisationId: org.organisationId, actorUserId: org.userId, companyId: d.companyId, entityType: 'document', entityId: documentId, metadata: { userId } }, tx);
    });
  }

  // ───────── immutable filing evidence ─────────
  /** One-way: locks one AVAILABLE version (its hash is recorded) and sets the retention date. The database refuses every later change. */
  async lockEvidence(org: OrgAccess, documentId: string, input: { versionId: string; reason: string; retainUntil?: string }) {
    const d = await this.getDocument(org, documentId, 'evidence:lock');
    if (d.evidenceLockedAt) throw conflict('This document is already locked as filing evidence', 'evidence_locked');
    if (d.status !== 'ACTIVE') throw conflict('Document is archived', 'document_archived');
    const minimum = new Date(); minimum.setUTCFullYear(minimum.getUTCFullYear() + EVIDENCE_DEFAULT_RETENTION_YEARS);
    const retainUntil = input.retainUntil ? new Date(input.retainUntil) : new Date(minimum.toISOString().slice(0, 10));
    if (retainUntil.getTime() < new Date(minimum.toISOString().slice(0, 10)).getTime()) {
      throw unprocessable(`Filing evidence must be kept for at least ${EVIDENCE_DEFAULT_RETENTION_YEARS} years`, 'retention_too_short');
    }
    return this.t(org, async (tx) => {
      const v = await tx.documentVersion.findFirst({ where: { id: input.versionId, documentId } });
      if (!v) throw notFound('Document version not found');
      if (v.status !== 'AVAILABLE' || !v.sha256) throw conflict('Only a scanned, AVAILABLE version can be locked as evidence', 'version_not_available');
      const locked = await tx.document.updateMany({ where: { id: documentId, evidenceLockedAt: null },
        data: { evidenceLockedAt: new Date(), evidenceLockedByUserId: org.userId, evidenceVersionId: v.id, evidenceSha256: v.sha256, evidenceReason: input.reason, retainUntil } });
      if (locked.count !== 1) throw conflict('This document is already locked as filing evidence', 'evidence_locked');
      const after = await tx.document.findUniqueOrThrow({ where: { id: documentId } });
      await this.audit.record({ action: 'document.evidence_locked', organisationId: org.organisationId, actorUserId: org.userId, companyId: d.companyId, entityType: 'document', entityId: documentId,
        after: { evidenceVersionId: v.id, evidenceSha256: v.sha256, retainUntil: retainUntil.toISOString().slice(0, 10) }, reason: input.reason }, tx);
      await publishEvent(tx, Events.documentEvidenceLocked, { aggregateId: documentId, organisationId: org.organisationId, actorUserId: org.userId,
        payload: { documentId, versionId: v.id, sha256: v.sha256, companyId: d.companyId, retainUntil: retainUntil.toISOString().slice(0, 10) } });
      return after;
    });
  }

  // ───────── OCR-ready pipeline: extraction results (data only) ─────────
  private extractionView(e: { text: string | null } & Record<string, unknown>, includeText: boolean) {
    const { text, ...rest } = e;
    return includeText ? { ...rest, text } : rest;
  }

  /** Extraction state of a version. The text is returned only on request and only to people who can read the document itself. */
  async getExtractions(org: OrgAccess, documentId: string, versionId: string, includeText: boolean) {
    await this.getVersion(org, documentId, versionId, 'document:read');
    const rows = await this.t(org, (tx) => tx.documentExtraction.findMany({ where: { documentVersionId: versionId }, orderBy: { createdAt: 'asc' } }));
    if (includeText && rows.some((r) => r.text)) {
      await this.audit.record({ action: 'document.extraction_read', organisationId: org.organisationId, actorUserId: org.userId, entityType: 'document_version', entityId: versionId });
    }
    return { items: rows.map((r) => this.extractionView(r as never, includeText)) };
  }

  /** Queues extraction for an AVAILABLE version (the route is behind the `documents.ocr` flag; the worker re-checks it). */
  async requestExtraction(org: OrgAccess, documentId: string, versionId: string) {
    if (this.config.OCR_PROVIDER === 'none') throw unprocessable('No OCR provider is configured', 'ocr_not_configured');
    const doc = await this.getDocument(org, documentId, 'document:upload');
    const v = await this.getVersion(org, documentId, versionId, 'document:upload');
    if (v.status !== 'AVAILABLE') throw conflict(`Document version is ${v.status}; only AVAILABLE versions can be read by OCR`, 'document_not_available');
    const provider = this.config.OCR_PROVIDER;
    const existing = await this.t(org, (tx) => tx.documentExtraction.findUnique({ where: { documentVersionId_provider: { documentVersionId: versionId, provider } } }));
    if (existing?.status === 'SUCCEEDED') return this.extractionView(existing as never, false);
    const row = await this.t(org, async (tx) => {
      const r = await tx.documentExtraction.upsert({ where: { documentVersionId_provider: { documentVersionId: versionId, provider } },
        create: { organisationId: org.organisationId, documentId, documentVersionId: versionId, provider, status: 'PENDING', requestedByUserId: org.userId },
        update: { status: 'PENDING', error: null, requestedByUserId: org.userId } });
      await this.audit.record({ action: 'document.extraction_requested', organisationId: org.organisationId, actorUserId: org.userId, entityType: 'document_version', entityId: versionId, metadata: { provider } }, tx);
      return r;
    });
    await this.jobs.enqueue(JobTypes.documentOcr, { documentVersionId: versionId }, {
      organisationId: org.organisationId, userId: org.userId, companyId: doc.companyId ?? undefined, idempotencyKey: `ocr:${versionId}:${Math.floor(Date.now() / 60_000)}`,
    });
    return this.extractionView(row as never, false);
  }
}
