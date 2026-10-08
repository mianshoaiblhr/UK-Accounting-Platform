import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { createDocumentSchema, newVersionSchema, paginationSchema } from '@uk/contracts';
import { Idempotent, Org, RequirePermissions } from '../common/decorators';
import type { AppRequest, OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { DocumentsService } from './documents.service';

const listQuery = paginationSchema.extend({ companyId: z.string().uuid().optional() });
const BASE = 'organisations/:organisationId/documents';

@Controller(BASE)
export class DocumentsController {
  constructor(private readonly svc: DocumentsService) {}

  @Post() @RequirePermissions('document:upload') @Idempotent()
  create(@Org() org: OrgAccess, @Body(new ZodPipe(createDocumentSchema)) b: z.output<typeof createDocumentSchema>) { return this.svc.create(org, b); }

  @Get() @RequirePermissions('document:read')
  list(@Org() org: OrgAccess, @Query(new ZodPipe(listQuery)) q: z.output<typeof listQuery>) { return this.svc.list(org, q); }

  @Get(':documentId') @RequirePermissions('document:read')
  get(@Org() org: OrgAccess, @Param('documentId', ParseUUIDPipe) id: string) { return this.svc.get(org, id); }

  @Post(':documentId/archive') @HttpCode(200) @RequirePermissions('document:archive')
  archive(@Org() org: OrgAccess, @Param('documentId', ParseUUIDPipe) id: string) { return this.svc.archive(org, id); }

  @Post(':documentId/versions') @RequirePermissions('document:upload') @Idempotent()
  newVersion(@Org() org: OrgAccess, @Param('documentId', ParseUUIDPipe) id: string, @Body(new ZodPipe(newVersionSchema)) b: z.output<typeof newVersionSchema>) {
    return this.svc.newVersion(org, id, b);
  }

  /** Body is parsed as raw bytes by middleware registered in bootstrap. */
  @Put(':documentId/versions/:versionId/content') @RequirePermissions('document:upload')
  upload(@Org() org: OrgAccess, @Param('documentId', ParseUUIDPipe) d: string, @Param('versionId', ParseUUIDPipe) v: string, @Req() req: AppRequest & { body: Buffer }) {
    return this.svc.uploadContent(org, d, v, req.body);
  }

  @Post(':documentId/versions/:versionId/complete') @HttpCode(200) @RequirePermissions('document:upload')
  complete(@Org() org: OrgAccess, @Param('documentId', ParseUUIDPipe) d: string, @Param('versionId', ParseUUIDPipe) v: string) { return this.svc.complete(org, d, v); }

  @Get(':documentId/versions/:versionId/download') @RequirePermissions('document:read')
  download(@Org() org: OrgAccess, @Param('documentId', ParseUUIDPipe) d: string, @Param('versionId', ParseUUIDPipe) v: string) { return this.svc.downloadLink(org, d, v); }

  @Get(':documentId/versions/:versionId/content') @RequirePermissions('document:read')
  async content(@Org() org: OrgAccess, @Param('documentId', ParseUUIDPipe) d: string, @Param('versionId', ParseUUIDPipe) v: string, @Res() res: Response) {
    const f = await this.svc.readContent(org, d, v);
    res.setHeader('Content-Type', f.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${f.filename.replace(/[^\w.\- ]/g, '_')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(f.data);
  }
}
