import { describe, expect, it } from 'vitest';
import { JOURNAL_SOURCES } from '@uk/contracts';
import { DRILL_RESOLVERS } from '@uk/accounting';

/** V1-RPT-02 / MAN-ACC-06 / XP-01 (DEC-043): every journal source has a drill-down resolver, so no report figure ends at a journal it cannot explain. */
describe('universal drill-down coverage', () => {
  it('every journal source is listed, and only MANUAL journals have no source transaction', () => {
    expect(Object.keys(DRILL_RESOLVERS).sort()).toEqual(Object.keys(JOURNAL_SOURCES).sort());
    expect(Object.entries(DRILL_RESOLVERS).filter(([, r]) => r === null).map(([k]) => k)).toEqual(['MANUAL']);
  });
});
