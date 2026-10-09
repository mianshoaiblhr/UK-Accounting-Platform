import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import { archiveDocumentSchema, createDocumentSchema, documentListQuerySchema, evidenceLockSchema, grantDocumentAccessSchema, newVersionSchema, updateDocumentSchema } from '@uk/contracts';
import { Idempotent, Org, RequireFeature, RequirePermissions } from '../common/decorators';
import type { AppRequest, OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { DocumentsService } from './documents.service';

const BASE = 'organisations/:organisationId/documents';

@Controller(BASE)
export class DocumentsController {
  constructor(private readonly svc: DocumentsService) {}

  @Post() @RequirePermissions('document:upload') @Idempotent()
  create(@Org() org: OrgAccess, @Body(new ZodPipe(createDocumentSchema)) b: z.output<typeof createDocumentSchema>) { return this.svc.create(org, b); }

  @Get() @RequirePermissions('document:read')
  list(@Org() org: OrgAccess, @Query(new ZodPipe(documentListQuerySchema)) q: z.output<typeof documentListQuerySchema>) { return this.svc.list(org, q); }

  @Get(':documentId') @RequirePermissions('document:read')
  get(@Org() org: OrgAccess, @Param('documentId', ParseUUIDPipe) id: string) { return this.svc.get(org, id); }

  @Patch(':documentId') @RequirePermissions('document:upload')
  update(@Org() org: OrgAccess, @Param('documentId', ParseUUIDPipe) id: string, @Body(new ZodPipe(updateDocumentSchema)) b: z.output<typeof updateDocumentSchema>) { return this.svc.update(org, id, b); }

  @Get(':documentId/access') @RequirePermissions('document:confidential')
  listAccess(@Org() org: OrgAccess, @Param('documentId', ParseUUIDPipe) id: string) { return this.svc.listAccess(org, id); }

  @Post(':documentId/access') @RequirePermissions('document:confidential')
  grantAccess(@Org() org: OrgAccess, @Param('documentId', ParseUUIDPipe) id: string, @Body(new ZodPipe(grantDocumentAccessSchema)) b: z.output<typeof grantDocumentAccessSchema>) { return this.svc.grantAccess(org, id, b.userId); }

  @Delete(':documentId/access/:userId') @HttpCode(204) @RequirePermissions('document:confidential')
  revokeAccess(@Org() org: OrgAccess, @Param('documentId', ParseUUIDPipe) id: string, @Param('userId', ParseUUIDPipe) userId: string) { return this.svc.revokeAccess(org, id, userId); }

  /** One-way: locks one verified version as immutable filing evidence. */
  @Post(':documentId/evidence-lock') @HttpCode(200) @RequirePermissions('evidence:lock')
  lockEvidence(@Org() org: OrgAccess, @Param('documentId', ParseUUIDPipe) id: string, @Body(new ZodPipe(evidenceLockSchema)) b: z.output<typeof evidenceLockSchema>) { return this.svc.lockEvidence(org, id, b); }

  @Post(':documentId/archive') @HttpCode(200) @RequirePermissions('document:archive')
  archive(@Org() org: OrgAccess, @Param('documentId', ParseUUIDPipe) id: string, @Body(new ZodPipe(archiveDocumentSchema)) b: z.output<typeof archiveDocumentSchema>) { return this.svc.archive(org, id, b.reason); }

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

  /** OCR / text extraction state of a version. `?text=true` includes the extracted text (audited). */
  @Get(':documentId/versions/:versionId/extraction') @RequirePermissions('document:read')
  extraction(@Org() org: OrgAccess, @Param('documentId', ParseUUIDPipe) d: string, @Param('versionId', ParseUUIDPipe) v: string, @Query('text') text?: string) { return this.svc.getExtractions(org, d, v, text === 'true'); }

  @Post(':documentId/versions/:versionId/extract') @HttpCode(202) @RequirePermissions('document:upload') @RequireFeature('documents.ocr')
  extract(@Org() org: OrgAccess, @Param('documentId', ParseUUIDPipe) d: string, @Param('versionId', ParseUUIDPipe) v: string) { return this.svc.requestExtraction(org, d, v); }

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
