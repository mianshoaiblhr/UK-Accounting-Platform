import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type { z } from 'zod';
import { createFolderSchema, folderListQuerySchema, updateFolderSchema } from '@uk/contracts';
import { Org, RequirePermissions } from '../common/decorators';
import type { OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { FoldersService } from './folders.service';

@Controller('organisations/:organisationId/document-folders')
export class FoldersController {
  constructor(private readonly svc: FoldersService) {}

  @Post() @RequirePermissions('document:upload')
  create(@Org() org: OrgAccess, @Body(new ZodPipe(createFolderSchema)) b: z.output<typeof createFolderSchema>) { return this.svc.create(org, b); }

  @Get() @RequirePermissions('document:read')
  list(@Org() org: OrgAccess, @Query(new ZodPipe(folderListQuerySchema)) q: z.output<typeof folderListQuerySchema>) { return this.svc.list(org, q); }

  @Get(':folderId') @RequirePermissions('document:read')
  get(@Org() org: OrgAccess, @Param('folderId', ParseUUIDPipe) id: string) { return this.svc.get(org, id); }

  @Patch(':folderId') @RequirePermissions('document:upload')
  update(@Org() org: OrgAccess, @Param('folderId', ParseUUIDPipe) id: string, @Body(new ZodPipe(updateFolderSchema)) b: z.output<typeof updateFolderSchema>) { return this.svc.update(org, id, b); }

  @Delete(':folderId') @HttpCode(204) @RequirePermissions('document:archive')
  remove(@Org() org: OrgAccess, @Param('folderId', ParseUUIDPipe) id: string) { return this.svc.remove(org, id); }
}
