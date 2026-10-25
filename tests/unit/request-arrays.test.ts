import { describe, expect, it } from 'vitest';
import * as contracts from '@uk/contracts';
import { MAX_REQUEST_ARRAY_ITEMS, ZodPipe, oversizedArray } from '../../apps/api/src/common/zod.pipe';

/**
 * DEC-077: a request array longer than MAX_REQUEST_ARRAY_ITEMS is refused before its schema runs, because zod reports an issue for every
 * failing element and never stops early (GHSA-mrhx-c7xc-m3w5). The guard must refuse nothing a schema accepts, so every array schema
 * the contracts export has a limit, and that limit is below the guard's.
 */
describe('request array guard', () => {
  it('finds the first oversized array, nested in objects and arrays', () => {
    expect(oversizedArray({ lines: [1, 2, 3] }, 3)).toBeNull();
    expect(oversizedArray({ lines: [1, 2, 3, 4] }, 3)).toBe('lines');
    expect(oversizedArray({ a: { b: [{ c: [0, 0, 0, 0] }] } }, 3)).toBe('a.b.0.c');
    expect(oversizedArray([[0, 0, 0, 0]], 3)).toBe('0');
    expect(oversizedArray(null)).toBeNull();
    // iterative: a deeply nested body does not overflow the stack
    let deep: unknown = [];
    for (let i = 0; i < 100_000; i += 1) deep = [deep];
    expect(oversizedArray(deep)).toBeNull();
  });

  it('refuses half a million items quickly, in the API\'s validation_error form, without running the schema', () => {
    const pipe = new ZodPipe(contracts.createCashTransactionSchema);
    const body = { lines: Array(500_000).fill(0) };
    const t = Date.now();
    let err: any;
    try { pipe.transform(body); } catch (e) { err = e; }
    expect(Date.now() - t).toBeLessThan(200);
    expect(err).toMatchObject({ status: 422, code: 'validation_error' });
    expect(JSON.stringify(err)).toContain(`At most ${MAX_REQUEST_ARRAY_ITEMS} items`);
  });

  it('every array schema the contracts export has a limit below the guard', () => {
    const unbounded: string[] = [];
    const over: string[] = [];
    const seen = new Set<unknown>();
    const walk = (s: any, path: string): void => {
      if (!s || typeof s !== 'object' || !s._def || seen.has(s)) return;
      seen.add(s);
      const d = s._def;
      if (d.typeName === 'ZodArray') {
        const max = d.exactLength?.value ?? d.maxLength?.value;
        if (max === undefined) unbounded.push(path);
        else if (max > MAX_REQUEST_ARRAY_ITEMS) over.push(`${path} (${max})`);
        walk(d.type, `${path}[]`);
        return;
      }
      if (d.typeName === 'ZodObject') for (const [k, v] of Object.entries(s.shape)) walk(v, `${path}.${k}`);
      for (const k of ['innerType', 'schema', 'type', 'valueType', 'keyType', 'left', 'right', 'in', 'out']) if (d[k]) walk(d[k], path);
      for (const o of d.options ?? []) walk(o, path);
      for (const o of d.items ?? []) walk(o, path);
    };
    for (const [name, value] of Object.entries(contracts)) if (name.endsWith('Schema')) walk(value, name);
    expect(seen.size).toBeGreaterThan(100);
    expect(over).toEqual([]);
    // an array without its own limit is still capped by the guard; the one there is today is listed, so the list can only shrink
    expect(unbounded).toEqual(['createRoleSchema.permissions']);
  });
});
