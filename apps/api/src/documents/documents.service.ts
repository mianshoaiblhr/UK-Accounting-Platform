import { Inject, Injectable } from '@nestjs/common';
import { ALLOWED_UPLOAD_TYPES, Events, JobTypes, type Permission } from '@uk/contracts';
import { publishEvent } from '@uk/platform';
import { badRequest, conflict, notFound, unprocessable, uuidv7, type AppConfig } from '@uk/core';
import type { StoragePort } from '@uk/adapters';
import type { Database, Tx } from '@uk/db';
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

  async create(org: OrgAccess, input: { name: string; companyId?: string; contentType: string; sizeBytes: number; documentClass: string }) {
    this.validateFile(input.contentType, input.sizeBytes);
    await org.access.requireResource('document:upload', input.companyId ?? null, 'Company not found');
    const documentId = uuidv7(), versionId = uuidv7();
    const storageKey = this.key(org.organisationId, documentId, 1, versionId);
    const out = await this.t(org, async (tx) => {
      if (input.companyId && !(await tx.company.findUnique({ where: { id: input.companyId } }))) throw notFound('Company not found');
      const document = await tx.document.create({
        data: { id: documentId, organisationId: org.organisationId, companyId: input.companyId, name: input.name, documentClass: input.documentClass, createdByUserId: org.userId },
      });
      const version = await tx.documentVersion.create({
        data: { id: versionId, organisationId: org.organisationId, documentId, versionNo: 1, storageKey, contentType: input.contentType, sizeBytes: input.sizeBytes, createdByUserId: org.userId },
      });
      await this.audit.record({ action: 'document.created', organisationId: org.organisationId, actorUserId: org.userId, entityType: 'document', entityId: documentId, metadata: { name: input.name, versionId } }, tx);
      return { document, version };
    });
    return { ...out, upload: await this.uploadInstructions(org, documentId, out.version) };
  }

  async newVersion(org: OrgAccess, documentId: string, input: { contentType: string; sizeBytes: number }) {
    this.validateFile(input.contentType, input.sizeBytes);
    const doc = await this.getDocument(org, documentId, 'document:upload');
    if (doc.status === 'ARCHIVED') throw conflict('Document is archived', 'document_archived');
    const versionId = uuidv7();
    const version = await this.t(org, async (tx) => {
      const last = await tx.documentVersion.aggregate({ where: { documentId }, _max: { versionNo: true } });
      const versionNo = (last._max.versionNo ?? 0) + 1;
      const v = await tx.documentVersion.create({
        data: { id: versionId, organisationId: org.organisationId, documentId, versionNo, storageKey: this.key(org.organisationId, documentId, versionNo, versionId), contentType: input.contentType, sizeBytes: input.sizeBytes, createdByUserId: org.userId },
      });
      await this.audit.record({ action: 'document.version_created', organisationId: org.organisationId, actorUserId: org.userId, entityType: 'document', entityId: documentId, metadata: { versionId, versionNo } }, tx);
      return v;
    });
    return { version, upload: await this.uploadInstructions(org, documentId, version) };
  }

  /** Loads a document the caller may act on with `perm` (permission is evaluated for the document's own company). */
  private async getDocument(org: OrgAccess, documentId: string, perm: Permission) {
    const d = await this.t(org, (tx) => tx.document.findUnique({ where: { id: documentId } }));
    if (!d) throw notFound('Document not found');
    await org.access.requireResource(perm, d.companyId, 'Document not found');
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
      return plain;
    });
    await this.jobs.enqueue(JobTypes.documentProcess, { documentVersionId: versionId }, {
      organisationId: org.organisationId, userId: org.userId, idempotencyKey: `docproc:${versionId}`,
    });
    return v;
  }

  async list(org: OrgAccess, q: { limit: number; cursor?: string; companyId?: string }) {
    const scoped = await org.access.companyWhere('document:read');
    const rows = await this.t(org, (tx) => tx.document.findMany({
      where: { ...scoped, ...(q.companyId ? { companyId: q.companyId } : {}) }, orderBy: { id: 'desc' }, take: q.limit + 1,
      include: { versions: { orderBy: { versionNo: 'desc' }, take: 1 } },
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    }));
    return { items: rows.slice(0, q.limit), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null };
  }

  async get(org: OrgAccess, documentId: string) {
    await this.getDocument(org, documentId, 'document:read');
    return this.t(org, (tx) => tx.document.findUniqueOrThrow({ where: { id: documentId }, include: { versions: { orderBy: { versionNo: 'desc' } } } }));
  }

  async archive(org: OrgAccess, documentId: string) {
    const d = await this.getDocument(org, documentId, 'document:archive');
    if (d.legalHold) throw conflict('Document is under legal hold', 'legal_hold');
    return this.t(org, async (tx) => {
      const r = await tx.document.update({ where: { id: documentId }, data: { status: 'ARCHIVED' } });
      await this.audit.record({ action: 'document.archived', organisationId: org.organisationId, actorUserId: org.userId, entityType: 'document', entityId: documentId }, tx);
      return r;
    });
  }

  async downloadLink(org: OrgAccess, documentId: string, versionId: string) {
    const v = await this.getVersion(org, documentId, versionId, 'document:read');
    if (v.status !== 'AVAILABLE') throw conflict(`Document version is ${v.status}; only AVAILABLE versions can be downloaded`, 'document_not_available');
    const doc = await this.getDocument(org, documentId, 'document:read');
    const url = (await this.storage.presignDownload(v.storageKey, doc.name, PRESIGN_SECONDS))
      ?? `/api/v1/organisations/${org.organisationId}/documents/${documentId}/versions/${versionId}/content`;
    await this.audit.record({ action: 'document.download_link_issued', organisationId: org.organisationId, actorUserId: org.userId, entityType: 'document_version', entityId: versionId });
    return { url, expiresInSeconds: PRESIGN_SECONDS, sha256: v.sha256 };
  }

  /** Streams content through the API (local driver). Same authorization and AVAILABLE gate as presigned links. */
  async readContent(org: OrgAccess, documentId: string, versionId: string) {
    const v = await this.getVersion(org, documentId, versionId, 'document:read');
    if (v.status !== 'AVAILABLE') throw conflict('Document version is not available', 'document_not_available');
    const doc = await this.getDocument(org, documentId, 'document:read');
    await this.audit.record({ action: 'document.downloaded', organisationId: org.organisationId, actorUserId: org.userId, entityType: 'document_version', entityId: versionId });
    return { data: await this.storage.getObject(v.storageKey), contentType: v.contentType, filename: doc.name };
  }
}
