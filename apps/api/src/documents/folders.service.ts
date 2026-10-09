import { Inject, Injectable } from '@nestjs/common';
import { conflict, notFound, unprocessable } from '@uk/core';
import { Prisma, type Database, type DocumentFolder, type Tx } from '@uk/db';
import { changeSet } from '@uk/platform';
import { AuditService } from '../audit/audit.service';
import { DB } from '../common/tokens';
import type { OrgAccess } from '../common/types';

/**
 * Document folders: a tree per company (or organisation-level). Folder permissions follow document permissions for the folder's own
 * company: reading needs `document:read`, creating/renaming/moving `document:upload`, deleting an empty folder `document:archive`.
 * Folders never hide documents: what a user can see in a folder is decided by document visibility, not by the folder.
 */
@Injectable()
export class FoldersService {
  constructor(@Inject(DB) private readonly db: Database, private readonly audit: AuditService) {}

  private t<T>(org: OrgAccess, fn: (tx: Tx) => Promise<T>) { return this.db.tenant({ organisationId: org.organisationId, userId: org.userId }, fn); }

  private async load(org: OrgAccess, id: string, perm: 'document:read' | 'document:upload' | 'document:archive'): Promise<DocumentFolder> {
    const f = await this.t(org, (tx) => tx.documentFolder.findUnique({ where: { id } }));
    if (!f) throw notFound('Folder not found');
    await org.access.requireResource(perm, f.companyId, 'Folder not found');
    return f;
  }

  async create(org: OrgAccess, input: { name: string; companyId?: string; parentId?: string }) {
    let companyId = input.companyId ?? null;
    if (input.parentId) {
      const parent = await this.load(org, input.parentId, 'document:upload');
      if (input.companyId && input.companyId !== parent.companyId) throw unprocessable('A folder must belong to the same company as its parent', 'folder_company_mismatch');
      companyId = parent.companyId;
    }
    await org.access.requireResource('document:upload', companyId, 'Company not found');
    return this.t(org, async (tx) => {
      if (companyId && !(await tx.company.findUnique({ where: { id: companyId } }))) throw notFound('Company not found');
      try {
        const f = await tx.documentFolder.create({ data: { organisationId: org.organisationId, companyId, parentId: input.parentId, name: input.name, createdByUserId: org.userId } });
        await this.audit.record({ action: 'document_folder.created', organisationId: org.organisationId, actorUserId: org.userId, companyId, entityType: 'document_folder', entityId: f.id, after: { name: f.name, parentId: f.parentId } }, tx);
        return f;
      } catch (e) { throw mapFolderError(e); }
    });
  }

  async list(org: OrgAccess, q: { companyId?: string; parentId?: string }) {
    const scope = await org.access.companyWhere('document:read');
    const items = await this.t(org, (tx) => tx.documentFolder.findMany({
      where: { AND: [scope, q.companyId ? { companyId: q.companyId } : {}, q.parentId ? { parentId: q.parentId } : {}] }, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: 500,
    }));
    return { items };
  }

  async get(org: OrgAccess, id: string) { return this.load(org, id, 'document:read'); }

  async update(org: OrgAccess, id: string, input: { name?: string; parentId?: string | null }) {
    const before = await this.load(org, id, 'document:upload');
    if (input.parentId) {
      const parent = await this.load(org, input.parentId, 'document:upload');
      if (parent.companyId !== before.companyId) throw unprocessable('A folder can only be moved within its own company', 'folder_company_mismatch');
    }
    return this.t(org, async (tx) => {
      try {
        const f = await tx.documentFolder.update({ where: { id }, data: { name: input.name, parentId: input.parentId } });
        await this.audit.record({ action: 'document_folder.updated', organisationId: org.organisationId, actorUserId: org.userId, companyId: f.companyId, entityType: 'document_folder', entityId: id, ...changeSet(before, f, ['name', 'parentId']) }, tx);
        return f;
      } catch (e) { throw mapFolderError(e); }
    });
  }

  async remove(org: OrgAccess, id: string) {
    const f = await this.load(org, id, 'document:archive');
    await this.t(org, async (tx) => {
      if (await tx.documentFolder.count({ where: { parentId: id } }) || await tx.document.count({ where: { folderId: id } })) throw conflict('The folder is not empty', 'folder_not_empty');
      await tx.documentFolder.delete({ where: { id } });
      await this.audit.record({ action: 'document_folder.deleted', organisationId: org.organisationId, actorUserId: org.userId, companyId: f.companyId, entityType: 'document_folder', entityId: id, before: { name: f.name } }, tx);
    });
  }
}

function mapFolderError(e: unknown): unknown {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return conflict('A folder with this name already exists here', 'folder_exists');
  const msg = String((e as Error)?.message ?? '');
  if (msg.includes('document_folder_sibling_name_uq')) return conflict('A folder with this name already exists here', 'folder_exists');
  if (msg.includes('itself or its own subfolder')) return unprocessable('A folder cannot be moved into itself or its own subfolder', 'folder_cycle');
  if (msg.includes('at most 8 levels')) return unprocessable('Folders can be nested at most 8 levels deep', 'folder_too_deep');
  if (msg.includes('same company as its parent')) return unprocessable('A folder must belong to the same company as its parent', 'folder_company_mismatch');
  return e;
}
