import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type { z } from 'zod';
import { createTaskSchema, taskListQuerySchema, updateTaskSchema } from '@uk/contracts';
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
}
