import { describe, expect, it } from 'vitest';
import { FEATURE_FLAGS, FEATURE_KEYS, isFeatureKey, parseFeatureDefaults } from './features';

describe('feature registry', () => {
  it('declares the specification\'s flag use cases (beta AI, tax rules, HMRC endpoints, filing formats, reporting standards)', () => {
    for (const k of ['ai.beta', 'tax.rules.next', 'hmrc.endpoints.new', 'filing.formats.new', 'reporting.standards.new']) expect(isFeatureKey(k), k).toBe(true);
  });
  it('every flag is described and defaults OFF (incomplete functionality is opt-in)', () => {
    for (const k of FEATURE_KEYS) { expect(FEATURE_FLAGS[k].description.length).toBeGreaterThan(10); expect(FEATURE_FLAGS[k].default).toBe(false); }
  });
  it('flag names are safe to store (matches the database check)', () => {
    for (const k of FEATURE_KEYS) expect(k).toMatch(/^[a-z][a-z0-9_.]{1,60}$/);
  });
});

describe('parseFeatureDefaults', () => {
  it('parses key=true|false lists, ignoring whitespace and empties', () => {
    expect(parseFeatureDefaults(' ai.beta = true , documents.ocr=false,, ')).toEqual({ 'ai.beta': true, 'documents.ocr': false });
    expect(parseFeatureDefaults('')).toEqual({});
    expect(parseFeatureDefaults(undefined)).toEqual({});
  });
  it('fails fast on unknown flags and malformed entries (a typo must not silently do nothing)', () => {
    expect(() => parseFeatureDefaults('ai.betaa=true')).toThrow(/unknown feature flag/);
    expect(() => parseFeatureDefaults('ai.beta=yes')).toThrow(/expected key=true\|false/);
    expect(() => parseFeatureDefaults('ai.beta')).toThrow(/expected key=true\|false/);
    expect(() => parseFeatureDefaults('ai.beta=true=false')).toThrow();
  });
});
