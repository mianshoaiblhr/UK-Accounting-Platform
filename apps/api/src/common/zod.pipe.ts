import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodTypeAny, z } from 'zod';
import { AppError } from '@uk/core';

/**
 * No request array may hold more items than this, before the schema runs (DEC-077). Zod reports an issue for every failing element of an
 * array and never stops early (GHSA-mrhx-c7xc-m3w5), so a 1 MB body of half a million bad items cost about 146 MB and 0.4 s to refuse.
 * Every limited array schema in the contracts has a lower limit of its own, so this refuses nothing a schema would accept
 * (tests/unit/request-arrays.test.ts walks them all).
 */
export const MAX_REQUEST_ARRAY_ITEMS = 5000;

/** The path of the first array in `value` longer than `max`, or null; iterative, so a deeply nested body cannot overflow the stack. */
export function oversizedArray(value: unknown, max = MAX_REQUEST_ARRAY_ITEMS): string | null {
  const stack: [unknown, string][] = [[value, '']];
  while (stack.length) {
    const [v, path] = stack.pop()!;
    if (Array.isArray(v)) {
      if (v.length > max) return path;
      v.forEach((x, i) => stack.push([x, path ? `${path}.${i}` : String(i)]));
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) stack.push([x, path ? `${path}.${k}` : k]);
    }
  }
  return null;
}

@Injectable()
export class ZodPipe<S extends ZodTypeAny> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}
  transform(value: unknown): z.output<S> {
    const big = oversizedArray(value);
    if (big !== null) throw new AppError(422, 'validation_error', 'Request validation failed', [{ path: big, message: `At most ${MAX_REQUEST_ARRAY_ITEMS} items` }]);
    const r = this.schema.safeParse(value ?? {});
    if (!r.success) {
      throw new AppError(422, 'validation_error', 'Request validation failed', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    }
    return r.data;
  }
}
