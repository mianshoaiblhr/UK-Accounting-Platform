import { describe, expect, it } from 'vitest';
import { convert, money, parseRateCsv, roundingTolerance, settle, splitCsv } from '@uk/accounting';
import { createExchangeRateSchema, fxSettingsSchema, importExchangeRatesSchema, rateString, revaluationSchema, supersedeExchangeRateSchema } from '@uk/contracts';

/** V1-M3: conversion, rounding (DEC-017), realised FX (DEC-018) and the rate-file parser. Deterministic pseudo-random "property" checks - no real rates anywhere. */
const prng = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const amount = (r: () => number, dp = 2) => (Math.floor(r() * 1_000_000) / 10 ** dp).toFixed(dp);
const rateOf = (r: () => number) => (0.5 + r() * 2).toFixed(8);

describe('convert: original x rate, rounded half-up to the functional minor units (DEC-017)', () => {
  it('rounds half away from zero at the boundary, not to even', () => {
    expect(convert(money('1.00'), money('0.125'), 2).toFixed(2)).toBe('0.13');     // 0.125 -> 0.13 (half-even would give 0.12)
    expect(convert(money('1.00'), money('0.135'), 2).toFixed(2)).toBe('0.14');
    expect(convert(money('1.00'), money('0.124999'), 2).toFixed(2)).toBe('0.12');
    expect(convert(money('10.00'), money('0.0125'), 2).toFixed(2)).toBe('0.13');
    expect(convert(money('-1.00'), money('0.125'), 2).toFixed(2)).toBe('-0.13');   // away from zero for negatives too
  });
  it('respects the currency\'s minor units (0, 2 and 3 decimals)', () => {
    expect(convert(money('100'), money('1.2345'), 0).toFixed(0)).toBe('123');
    expect(convert(money('100'), money('1.2355'), 0).toFixed(0)).toBe('124');
    expect(convert(money('1'), money('0.12345'), 3).toFixed(3)).toBe('0.123');
    expect(convert(money('1'), money('0.1235'), 3).toFixed(3)).toBe('0.124');
  });
  it('is exact: a rate with 8 decimals is never rounded before use', () => {
    expect(convert(money('1000000.00'), money('1.00000001'), 2).toFixed(2)).toBe('1000000.01');
    expect(convert(money('1000000.00'), money('1.00000000'), 2).toFixed(2)).toBe('1000000.00');
  });
  it('reverse conversion returns the original within the tolerance implied by the rate', () => {
    const r = prng(7);
    for (let i = 0; i < 500; i++) {
      const orig = money(amount(r)), rate = money(rateOf(r));
      const there = convert(orig, rate, 2);
      const back = convert(there, money(1).div(rate), 2);
      // error of the first rounding is <= 0.005 functional, which maps to <= 0.005/rate original, plus 0.005 for the second rounding
      expect(back.minus(orig).abs().lte(money('0.005').div(rate).plus('0.005').plus('0.000001'))).toBe(true);
    }
  });
  it('totals do not depend on line order', () => {
    const r = prng(11);
    for (let i = 0; i < 100; i++) {
      const lines = Array.from({ length: 8 }, () => money(amount(r)));
      const rate = money(rateOf(r));
      const sum = (xs: typeof lines) => xs.reduce((t, x) => t.plus(convert(x, rate, 2)), money(0));
      expect(sum(lines).equals(sum([...lines].reverse()))).toBe(true);
      expect(sum(lines).equals(sum([...lines].sort((a, b) => a.comparedTo(b))))).toBe(true);
    }
  });
  it('the per-line rounding difference of a balanced foreign journal is within one minor unit per line', () => {
    const r = prng(3);
    for (let i = 0; i < 300; i++) {
      const n = 2 + Math.floor(r() * 6);
      const debits = Array.from({ length: n }, () => money(amount(r)));
      const total = debits.reduce((t, x) => t.plus(x), money(0));
      const rate = money(rateOf(r));
      const fd = debits.reduce((t, x) => t.plus(convert(x, rate, 2)), money(0));
      const fc = convert(total, rate, 2);                       // one credit line for the whole amount
      expect(fd.minus(fc).abs().lte(roundingTolerance(n + 1, 2))).toBe(true);
    }
  });
  it('tolerance is one minor unit per line', () => {
    expect(roundingTolerance(1, 2).toFixed(2)).toBe('0.01');
    expect(roundingTolerance(6, 2).toFixed(2)).toBe('0.06');
    expect(roundingTolerance(3, 0).toFixed(0)).toBe('3');
    expect(roundingTolerance(2, 3).toFixed(3)).toBe('0.002');
  });
});

describe('settle: realised FX at settlement (DEC-018)', () => {
  it('a full settlement clears the carried value exactly and the difference is settlement minus carried', () => {
    const s = settle({ totalOriginal: money('100.00'), settledOriginal: money('100.00'), carryingFunctional: money('125.00'), settlementRate: money('1.30'), minorUnits: 2 });
    expect([s.carriedShare.toFixed(2), s.settlementFunctional.toFixed(2), s.difference.toFixed(2)]).toEqual(['125.00', '130.00', '5.00']);
  });
  it('a loss when the settlement rate is lower', () => {
    const s = settle({ totalOriginal: money('100.00'), settledOriginal: money('100.00'), carryingFunctional: money('125.00'), settlementRate: money('1.20'), minorUnits: 2 });
    expect(s.difference.toFixed(2)).toBe('-5.00');
  });
  it('partial settlements prorate the carried value and, summed with the final one, clear it with no residue', () => {
    let remainingOrig = money('100.00'), remainingCarry = money('125.01'), totalDiff = money(0), totalCarried = money(0);
    for (const [part, rate] of [['30.00', '1.31'], ['30.00', '1.28'], ['40.00', '1.33']] as const) {
      const s = settle({ totalOriginal: remainingOrig, settledOriginal: money(part), carryingFunctional: remainingCarry, settlementRate: money(rate), minorUnits: 2 });
      totalDiff = totalDiff.plus(s.difference); totalCarried = totalCarried.plus(s.carriedShare);
      remainingOrig = remainingOrig.minus(part); remainingCarry = remainingCarry.minus(s.carriedShare);
    }
    expect(remainingOrig.isZero()).toBe(true);
    expect(totalCarried.toFixed(2)).toBe('125.01');            // everything carried was released: no residue
    expect(remainingCarry.isZero()).toBe(true);
    expect(totalDiff.toFixed(2)).toBe(money('39.30').plus('38.40').plus('53.20').minus('125.01').toFixed(2));
  });
  it('refuses nothing outstanding and amounts beyond the outstanding balance', () => {
    expect(() => settle({ totalOriginal: money(0), settledOriginal: money(0), carryingFunctional: money(0), settlementRate: money(1), minorUnits: 2 })).toThrow(/Nothing is outstanding/);
    expect(() => settle({ totalOriginal: money(10), settledOriginal: money(11), carryingFunctional: money(10), settlementRate: money(1), minorUnits: 2 })).toThrow(/between zero and the outstanding/);
  });
});

describe('rate file (CSV) parser', () => {
  const ok = 'from,to,valid_from,valid_to,rate\nUSD,,2026-03-02,,1.25000000\nEUR,GBP,2026-03-02,2026-03-02,0.85\n';
  it('parses a DAILY file; blank to = the company currency, blank valid_to = the same day', () => {
    const r = parseRateCsv(ok, { defaultTo: 'GBP', kind: 'DAILY' });
    expect(r.errors).toEqual([]);
    expect(r.rows.map((x) => [x.from, x.to, x.validFrom, x.validTo, x.rate])).toEqual([['USD', 'GBP', '2026-03-02', '2026-03-02', '1.25000000'], ['EUR', 'GBP', '2026-03-02', '2026-03-02', '0.85']]);
  });
  it('parses a PERIOD file and accepts any column order, quotes, CRLF and a BOM', () => {
    const r = parseRateCsv('﻿"rate","valid_to","valid_from","from"\r\n"1.1","2026-03-31","2026-03-01","USD"\r\n', { defaultTo: 'GBP', kind: 'PERIOD' });
    expect(r.errors).toEqual([]);
    expect(r.rows[0]).toMatchObject({ from: 'USD', to: 'GBP', validFrom: '2026-03-01', validTo: '2026-03-31', rate: '1.1', kind: 'PERIOD' });
  });
  it('reports every problem with its line and stores nothing: bad currency, impossible date, zero/negative/too-precise/non-numeric rate, DAILY range, PERIOD without end', () => {
    const bad = 'from,to,valid_from,valid_to,rate\nusd1,,2026-02-30,,1.2\nUSD,USD,2026-03-02,,1.2\nUSD,,2026-03-02,,0\nUSD,,2026-03-02,,-1\nUSD,,2026-03-02,,1.123456789\nUSD,,2026-03-02,,abc\nUSD,,2026-03-02,2026-03-05,1.2\n';
    const r = parseRateCsv(bad, { defaultTo: 'GBP', kind: 'DAILY' });
    const lines = new Set(r.errors.map((e) => e.line));
    expect([...lines].sort()).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(parseRateCsv('from,valid_from,rate\nUSD,2026-03-02,1.2\n', { defaultTo: 'GBP', kind: 'PERIOD' }).errors[0]!.message).toMatch(/PERIOD rate needs valid_to/);
  });
  it('rejects a file with missing columns or no data, and a header-only file imports nothing', () => {
    expect(parseRateCsv('from,rate\nUSD,1.2\n', { defaultTo: 'GBP', kind: 'DAILY' }).errors.map((e) => e.message)).toContain('Missing column valid_from');
    expect(parseRateCsv('', { defaultTo: 'GBP', kind: 'DAILY' }).errors).toEqual([{ line: 1, message: 'The file is empty' }]);
    expect(parseRateCsv('from,valid_from,rate\n', { defaultTo: 'GBP', kind: 'DAILY' })).toEqual({ rows: [], errors: [] });
  });
  it('splitCsv handles embedded commas, doubled quotes and blank lines', () => {
    expect(splitCsv('a,"b,c","say ""hi"""\n\nd,e,f')).toEqual([['a', 'b,c', 'say "hi"'], ['d', 'e', 'f']]);
  });
});

describe('request schemas', () => {
  it('rates are positive decimal strings with at most 8 decimals', () => {
    for (const ok of ['1', '1.25', '0.00000001', '123456789.12345678']) expect(rateString.safeParse(ok).success, ok).toBe(true);
    for (const bad of ['0', '0.0', '-1', '1.123456789', '1e3', ' 1', '', 'abc']) expect(rateString.safeParse(bad).success, bad).toBe(false);
    expect(rateString.safeParse(1.25).success).toBe(false);                                   // never a JSON number
  });
  it('a manual rate needs a source; DAILY applies on one date; PERIOD needs an end', () => {
    const base = { fromCurrency: 'USD', validFrom: '2026-03-02', rate: '1.25', source: 'Bank statement dated 2 March' };
    expect(createExchangeRateSchema.safeParse(base).success).toBe(true);
    expect(createExchangeRateSchema.safeParse({ ...base, source: 'ab' }).success).toBe(false);
    expect(createExchangeRateSchema.safeParse({ ...base, validTo: '2026-03-05' }).success).toBe(false);
    expect(createExchangeRateSchema.safeParse({ ...base, kind: 'PERIOD' }).success).toBe(false);
    expect(createExchangeRateSchema.safeParse({ ...base, kind: 'PERIOD', validTo: '2026-03-31' }).success).toBe(true);
    expect(createExchangeRateSchema.safeParse({ ...base, toCurrency: 'USD' }).success).toBe(false);
    expect(createExchangeRateSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
  it('supersede needs a reason of 20 characters; import caps size; settings need a reason and valid series; revaluation takes rate ids only', () => {
    expect(supersedeExchangeRateSchema.safeParse({ rate: '1.3', source: 'Corrected from the bank advice', reason: 'short' }).success).toBe(false);
    expect(supersedeExchangeRateSchema.safeParse({ rate: '1.3', source: 'Corrected from the bank advice', reason: 'Typo in the original entry of the rate' }).success).toBe(true);
    expect(importExchangeRatesSchema.safeParse({ publisher: 'X', retrievedAt: '2026-03-02T10:00:00Z', csv: 'a' }).success).toBe(true);
    expect(importExchangeRatesSchema.safeParse({ publisher: 'X', retrievedAt: 'yesterday', csv: 'a' }).success).toBe(false);
    expect(importExchangeRatesSchema.safeParse({ publisher: 'X', retrievedAt: '2026-03-02T10:00:00Z', csv: 'a'.repeat(1_000_001) }).success).toBe(false);
    const fx = { roundingAccountId: null, realisedAccountId: null, unrealisedAccountId: null, defaultSeries: { USD: { publisher: 'X', series: null } }, reason: 'Initial FX configuration for this company' };
    expect(fxSettingsSchema.safeParse(fx).success).toBe(true);
    expect(fxSettingsSchema.safeParse({ ...fx, defaultSeries: { usd: { publisher: 'X' } } }).success).toBe(false);
    expect(fxSettingsSchema.safeParse({ ...fx, reason: 'short' }).success).toBe(false);
    expect(revaluationSchema.safeParse({ rates: { USD: '11111111-1111-4111-8111-111111111111' } }).success).toBe(true);
    expect(revaluationSchema.safeParse({ rates: { USD: '1.25' } }).success).toBe(false);
  });
});
