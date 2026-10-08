import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodTypeAny, z } from 'zod';
import { AppError } from '@uk/core';

@Injectable()
export class ZodPipe<S extends ZodTypeAny> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}
  transform(value: unknown): z.output<S> {
    const r = this.schema.safeParse(value ?? {});
    if (!r.success) {
      throw new AppError(422, 'validation_error', 'Request validation failed', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    }
    return r.data;
  }
}
