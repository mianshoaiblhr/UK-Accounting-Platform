import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkExpression, createDisclosureRuleSchema, createMapEntrySchema, createStandardSchema, createStandardVersionSchema, createStatutoryLineSchema, createValidationRuleSchema, parseTemplate,
} from '@uk/contracts';

/** DEC-064: the draft wording packs are well formed before anyone imports them; each rule names its provision and a note for the verifier. Content correctness is the verifier's (DEC-052). */
const DIR = resolve(__dirname, '../../content/standards/drafts');
const packs = readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => ({ file: f, pack: JSON.parse(readFileSync(resolve(DIR, f), 'utf8')) }));

describe('draft wording packs (DEC-064)', () => {
  it('there are two: FRS 105 micro-entity and FRS 102 Section 1A small', () => {
    expect(packs.map((p) => p.pack.pack).sort()).toEqual(['FRS102-1A-SMALL-DRAFT', 'FRS105-MICRO-DRAFT']);
  });
  for (const { file, pack } of packs) {
    describe(file, () => {
      it('says it is a draft, unverified, not retrieved from the source', () => {
        expect(pack.status).toMatch(/^DRAFT/);
        expect(pack.status).toMatch(/UNVERIFIED/);
        expect(pack.version.label).toMatch(/unverified/i);
        expect(pack.version.source.provision).toMatch(/not retrieved/i);
      });
      it('every part passes the API\'s own schemas', () => {
        expect(createStandardSchema.safeParse(pack.standard).success).toBe(true);
        expect(createStandardVersionSchema.safeParse(pack.version).success, JSON.stringify(createStandardVersionSchema.safeParse(pack.version).error?.issues)).toBe(true);
        for (const l of pack.lines) expect(createStatutoryLineSchema.safeParse(l).success, l.key).toBe(true);
        for (const [sourceLine, accountSubtype, targetKey] of pack.mapEntries) expect(createMapEntrySchema.safeParse({ sourceLine, accountSubtype, targetKey }).success, sourceLine).toBe(true);
        for (const r of pack.validationRules) expect(createValidationRuleSchema.safeParse(r).success, r.key).toBe(true);
        for (const { source: _s, verifierNote: _n, ...r } of pack.rules) expect(createDisclosureRuleSchema.safeParse(r).success, r.key).toBe(true);
      });
      it('lines, totals, the map, rules and wording refer only to lines of the pack; the templates follow the grammar', () => {
        const keys = new Set<string>(pack.lines.map((l: { key: string }) => l.key));
        expect(keys.size).toBe(pack.lines.length);
        for (const l of pack.lines) {
          if (l.parentKey) expect(keys.has(l.parentKey), `${l.key} parent`).toBe(true);
          for (const t of l.formula ?? []) expect(keys.has(t.line), `${l.key} total`).toBe(true);
        }
        for (const [, , target] of pack.mapEntries) expect(keys.has(target), target).toBe(true);
        for (const r of pack.validationRules) expect(checkExpression(r.expression, keys), r.key).toEqual([]);
        const ruleKeys = new Set<string>();
        for (const r of pack.rules) {
          expect(ruleKeys.has(r.key), `duplicate ${r.key}`).toBe(false); ruleKeys.add(r.key);
          const t = parseTemplate(r.body);
          expect(t.errors, r.key).toEqual([]);
          for (const k of t.lines) expect(keys.has(k), `${r.key} refers to ${k}`).toBe(true);
        }
      });
      it('every rule names the provision it reflects and carries a note for the verifier', () => {
        for (const r of pack.rules) {
          expect(r.source, r.key).toMatch(/Companies Act 2006|FRS 10[25]|SI 2008\/409/);
          expect(r.verifierNote?.length, r.key).toBeGreaterThan(10);
        }
      });
    });
  }
});
