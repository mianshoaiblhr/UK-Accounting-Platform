import { describe, expect, it } from 'vitest';
import { presentWholePounds, vatReturnStatus } from './vat-return';

describe('presentWholePounds (V5-M2, DEC-091): boxes 6 to 9 by the verified method', () => {
  it('TRUNCATE_PENCE leaves the pence out, towards zero', () => {
    expect(['1000.55', '1000.99', '1000.00', '1000', '0.99', '-12.30', '-0.40'].map((a) => presentWholePounds(a, 'TRUNCATE_PENCE'))).toEqual(['1000', '1000', '1000', '1000', '0', '-12', '0']);
  });
  it('ROUND_TO_POUND rounds half up, away from zero at .50', () => {
    expect(['1000.49', '1000.50', '1000.55', '0.49', '0.50', '-12.50', '-12.49', '999999999999.50'].map((a) => presentWholePounds(a, 'ROUND_TO_POUND'))).toEqual(['1000', '1001', '1001', '0', '1', '-13', '-12', '1000000000000']);
  });
  it('refuses anything that is not a decimal amount', () => {
    expect(() => presentWholePounds('1,000.00', 'TRUNCATE_PENCE')).toThrow(/Not a decimal/);
    expect(() => presentWholePounds('1e3', 'ROUND_TO_POUND')).toThrow(/Not a decimal/);
  });
});

describe('vatReturnStatus (V5-M1, DEC-090)', () => {
  const ev = (kind: string, fingerprint: string, seq: number) => ({ kind, fingerprint, seq });
  it('DRAFT with no live preparation; PREPARED; REVIEWED only after the live preparation; APPROVED once locked', () => {
    expect(vatReturnStatus({ locked: false, fingerprint: 'a', events: [] })).toBe('DRAFT');
    expect(vatReturnStatus({ locked: false, fingerprint: 'b', events: [ev('PREPARED', 'a', 1)] })).toBe('DRAFT');
    expect(vatReturnStatus({ locked: false, fingerprint: 'a', events: [ev('PREPARED', 'a', 1)] })).toBe('PREPARED');
    expect(vatReturnStatus({ locked: false, fingerprint: 'a', events: [ev('PREPARED', 'a', 1), ev('REVIEWED', 'a', 2)] })).toBe('REVIEWED');
    expect(vatReturnStatus({ locked: false, fingerprint: 'a', events: [ev('REVIEWED', 'a', 1), ev('PREPARED', 'a', 2)] })).toBe('PREPARED');
    expect(vatReturnStatus({ locked: true, fingerprint: 'z', events: [] })).toBe('APPROVED');
  });
});
