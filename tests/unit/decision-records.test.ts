import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RETENTION_CATEGORIES } from '../../packages/contracts/src/retention';

/** DEC-003 / DEC-007: the legal verification schedule and the decision log cannot silently drift from the code or claim an approval. */
const ROOT = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const schedule = read('docs/legal/retention-verification-schedule.md');
const log = read('docs/architecture/decision-log.md');

describe('legal verification schedule', () => {
  it('has a section for every retention category, with the registry period', () => {
    for (const c of RETENTION_CATEGORIES) {
      const m = schedule.match(new RegExp(`### ${c.code} - [^\\n]+\\n\\n\\| Field \\| Content \\|\\n\\|---\\|---\\|\\n\\| Provisional period \\| \\*\\*([^*]+)\\*\\*`));
      expect(m, `schedule section for ${c.code}`).toBeTruthy();
      if (c.kind === 'PERIOD') {
        const expected = c.years != null ? `${c.years} year` : `${c.days} day`;
        expect(m![1], c.code).toContain(expected);
      }
    }
  });
  it('records the owner\'s confirmation (DEC-084) without claiming the sources were verified', () => {
    expect(schedule).toMatch(/periods CONFIRMED by the product owner on 2026-10-27 \(DEC-084\); sources UNVERIFIED/);
    expect(schedule).toMatch(/not legal advice/i);
    expect(schedule).toMatch(/IP address and user agent - flagged for privacy review/);
    expect(schedule).toMatch(/Lawful basis:\*\* legitimate interests \(UK GDPR Art 6\(1\)\(f\)\)/);
    expect(schedule).not.toMatch(/\| Verification status \| (VERIFIED|CONFIRMED|APPROVED)/);
  });
  it('every retention category is CONFIRMED, and only because DEC-084 records it', () => {
    expect(RETENTION_CATEGORIES.filter((c) => c.status !== 'CONFIRMED')).toEqual([]);
    expect(log).toMatch(/### DEC-084 - Retention and privacy approved/);
  });
});

describe('decision log', () => {
  it('records the seven decisions, append-only, and says V0 approval is not production approval', () => {
    for (let i = 1; i <= 7; i++) expect(log).toContain(`DEC-00${i}`);
    expect(log).toMatch(/not production approval/i);
    expect(log).toMatch(/Entries are never edited or deleted/);
  });
  it('keeps S4(b) frozen and development on synthetic data until the decisions are made', () => {
    expect(log).toMatch(/S4\(b\) is frozen/);
    expect(log).toMatch(/synthetic\/test data only/);
  });
  it('unfreezes S4(b) only through DEC-084, and keeps real client data out of everything but production after go-live (DEC-085)', () => {
    expect(log).toMatch(/\*\*S4\(b\) is unfrozen\.\*\* Purge jobs/);
    expect(log).toMatch(/DEC-014's synthetic-data rule\*\* stays in force everywhere except production after go-live/);
  });
});
