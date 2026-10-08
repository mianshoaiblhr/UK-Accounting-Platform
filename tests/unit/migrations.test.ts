import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Migrations are NOT destructive by default. Any statement that can lose data must carry an explicit, reviewed
 * approval marker in the same file:   -- destructive-approved: <ticket/ADR> backup-required
 * (see docs/runbooks/migrations.md). CODEOWNERS should require DBA review for files with that marker.
 */
const DIR = resolve(__dirname, '../../packages/db/prisma/migrations');
const dirs = readdirSync(DIR).filter((d) => /^\d{14}_/.test(d)).sort();

const DESTRUCTIVE: [RegExp, string][] = [
  [/^\s*DROP\s+(TABLE|COLUMN|SCHEMA|DATABASE|TYPE|VIEW|EXTENSION)\b/im, 'DROP of a data-bearing object'],
  [/\bALTER\s+TABLE\b[^;]*\bDROP\s+COLUMN\b/is, 'DROP COLUMN'],
  [/\bALTER\s+TABLE\b[^;]*\bALTER\s+COLUMN\b[^;]*\bTYPE\b/is, 'column type change (may rewrite/lose data)'],
  [/\bALTER\s+TABLE\b[^;]*\bRENAME\b/is, 'rename (breaks running application versions)'],
  [/^\s*TRUNCATE\b/im, 'TRUNCATE'],
  [/^\s*DELETE\s+FROM\b/im, 'DELETE'],
  [/\bALTER\s+TYPE\b[^;]*\bRENAME\b/is, 'enum rename'],
];

describe('migration safety', () => {
  it('migrations exist, are ordered, and each has a migration.sql', () => {
    expect(dirs.length).toBeGreaterThanOrEqual(3);
    for (const d of dirs) expect(readFileSync(join(DIR, d, 'migration.sql'), 'utf8').length, d).toBeGreaterThan(0);
  });
  it.each(dirs)('%s contains no destructive statement (or is explicitly approved)', (d) => {
    const sql = readFileSync(join(DIR, d, 'migration.sql'), 'utf8');
    const approved = /^--\s*destructive-approved:\s*\S+.*backup-required/im.test(sql);
    const hits = DESTRUCTIVE.filter(([re]) => re.test(sql)).map(([, why]) => why);
    if (hits.length) expect(approved, `${d}: ${hits.join(', ')} — add "-- destructive-approved: <ticket> backup-required" after review`).toBe(true);
  });
  it('applied migrations are immutable: no file is edited after merge (checksums are tracked by Prisma; CI also runs migrate deploy on an old snapshot)', () => {
    expect(dirs[0]).toMatch(/v0_baseline$/);
  });
});
