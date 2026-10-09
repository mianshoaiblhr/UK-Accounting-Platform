/**
 * Feature-flag registry. A flag exists only if it is declared here (name, purpose, default), so a typo can never silently create or
 * read a flag. Resolution order at runtime: per-organisation override > environment default (FEATURE_FLAG_DEFAULTS) > this default.
 * Every version that ships incomplete functionality adds its flag here and gates the entry points with it (Manifest: cross-version rule).
 */
export interface FeatureFlagDef { description: string; default: boolean }

export const FEATURE_FLAGS = {
  'bookkeeping.core': { description: 'V1 bookkeeping engine: chart of accounts, journals, general ledger, trial balance (incomplete while V1 is being built)', default: false },
  'ai.beta': { description: 'AI suggestions (beta): requesting and reviewing AI proposals', default: false },
  'documents.ocr': { description: 'OCR stage in the document pipeline (requires an OCR provider)', default: false },
  'tax.rules.next': { description: 'The next effective-dated tax rule set (not yet live)', default: false },
  'hmrc.endpoints.new': { description: 'New HMRC API endpoints', default: false },
  'filing.formats.new': { description: 'New statutory filing formats', default: false },
  'reporting.standards.new': { description: 'New reporting standards', default: false },
} as const satisfies Record<string, FeatureFlagDef>;

export type FeatureKey = keyof typeof FEATURE_FLAGS;
export const FEATURE_KEYS = Object.keys(FEATURE_FLAGS) as FeatureKey[];
export const isFeatureKey = (k: string): k is FeatureKey => Object.prototype.hasOwnProperty.call(FEATURE_FLAGS, k);

/** "key=true,other=false" -> validated map. Unknown keys and non-boolean values are configuration errors (fail fast at boot). */
export function parseFeatureDefaults(raw: string | undefined): Partial<Record<FeatureKey, boolean>> {
  const out: Partial<Record<FeatureKey, boolean>> = {};
  for (const part of (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [k, v, ...rest] = part.split('=').map((s) => s.trim());
    if (!k || rest.length || (v !== 'true' && v !== 'false')) throw new Error(`Invalid FEATURE_FLAG_DEFAULTS entry "${part}" (expected key=true|false)`);
    if (!isFeatureKey(k)) throw new Error(`Invalid FEATURE_FLAG_DEFAULTS: unknown feature flag "${k}"`);
    out[k] = v === 'true';
  }
  return out;
}
