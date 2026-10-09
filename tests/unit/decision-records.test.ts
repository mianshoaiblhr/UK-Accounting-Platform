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
  it('is explicit that nothing is verified or approved, and flags IP address / user agent for privacy review', () => {
    expect(schedule).toMatch(/UNVERIFIED and NOT APPROVED/);
    expect(schedule).toMatch(/not legal advice/i);
    expect(schedule).toMatch(/IP address and user agent - flagged for privacy review/);
    expect(schedule).toMatch(/Lawful basis:\*\* not decided/);
    expect(schedule).not.toMatch(/\| Verification status \| (VERIFIED|CONFIRMED|APPROVED)/);
  });
  it('every retention category in the registry is still PROVISIONAL (no silent approval)', () => {
    expect(RETENTION_CATEGORIES.filter((c) => c.status !== 'PROVISIONAL')).toEqual([]);
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
});
