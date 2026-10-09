import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type { z } from 'zod';
import { attachTaskDocumentSchema, createTaskCommentSchema, createTaskReminderSchema, createTaskSchema, reviewTaskSchema, taskListQuerySchema, updateTaskSchema } from '@uk/contracts';
import { Idempotent, Org, RequirePermissions } from '../common/decorators';
import type { OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { TasksService } from './tasks.service';

@Controller('organisations/:organisationId/tasks')
export class TasksController {
  constructor(private readonly svc: TasksService) {}

  @Post() @RequirePermissions('task:manage') @Idempotent()
  create(@Org() org: OrgAccess, @Body(new ZodPipe(createTaskSchema)) b: z.output<typeof createTaskSchema>) { return this.svc.create(org, b); }

  @Get() @RequirePermissions('task:read')
  list(@Org() org: OrgAccess, @Query(new ZodPipe(taskListQuerySchema)) q: z.output<typeof taskListQuerySchema>) { return this.svc.list(org, q); }

  @Get(':taskId') @RequirePermissions('task:read')
  get(@Org() org: OrgAccess, @Param('taskId', ParseUUIDPipe) id: string) { return this.svc.get(org, id); }

  @Patch(':taskId') @RequirePermissions('task:manage')
  update(@Org() org: OrgAccess, @Param('taskId', ParseUUIDPipe) id: string, @Body(new ZodPipe(updateTaskSchema)) b: z.output<typeof updateTaskSchema>) { return this.svc.update(org, id, b); }

  /** Reviewer decision. Needs only task:read at the gate: the service requires the caller to BE the designated reviewer. */
  @Post(':taskId/review') @RequirePermissions('task:read') @HttpCode(200)
  review(@Org() org: OrgAccess, @Param('taskId', ParseUUIDPipe) id: string, @Body(new ZodPipe(reviewTaskSchema)) b: z.output<typeof reviewTaskSchema>) { return this.svc.review(org, id, b); }

  @Get(':taskId/comments') @RequirePermissions('task:read')
  comments(@Org() org: OrgAccess, @Param('taskId', ParseUUIDPipe) id: string) { return this.svc.listComments(org, id); }

  @Post(':taskId/comments') @RequirePermissions('task:read') @Idempotent()
  comment(@Org() org: OrgAccess, @Param('taskId', ParseUUIDPipe) id: string, @Body(new ZodPipe(createTaskCommentSchema)) b: z.output<typeof createTaskCommentSchema>) { return this.svc.addComment(org, id, b.body); }

  @Get(':taskId/attachments') @RequirePermissions('task:read')
  attachments(@Org() org: OrgAccess, @Param('taskId', ParseUUIDPipe) id: string) { return this.svc.listAttachments(org, id); }

  @Post(':taskId/attachments') @RequirePermissions('task:manage')
  attach(@Org() org: OrgAccess, @Param('taskId', ParseUUIDPipe) id: string, @Body(new ZodPipe(attachTaskDocumentSchema)) b: z.output<typeof attachTaskDocumentSchema>) { return this.svc.attach(org, id, b.documentId); }

  @Delete(':taskId/attachments/:documentId') @RequirePermissions('task:manage') @HttpCode(204)
  detach(@Org() org: OrgAccess, @Param('taskId', ParseUUIDPipe) id: string, @Param('documentId', ParseUUIDPipe) documentId: string) { return this.svc.detach(org, id, documentId); }

  @Get(':taskId/reminders') @RequirePermissions('task:read')
  reminders(@Org() org: OrgAccess, @Param('taskId', ParseUUIDPipe) id: string) { return this.svc.listReminders(org, id); }

  @Post(':taskId/reminders') @RequirePermissions('task:manage')
  addReminder(@Org() org: OrgAccess, @Param('taskId', ParseUUIDPipe) id: string, @Body(new ZodPipe(createTaskReminderSchema)) b: z.output<typeof createTaskReminderSchema>) { return this.svc.addReminder(org, id, b); }

  @Delete(':taskId/reminders/:reminderId') @RequirePermissions('task:manage') @HttpCode(204)
  cancelReminder(@Org() org: OrgAccess, @Param('taskId', ParseUUIDPipe) id: string, @Param('reminderId', ParseUUIDPipe) reminderId: string) { return this.svc.cancelReminder(org, id, reminderId); }
}
