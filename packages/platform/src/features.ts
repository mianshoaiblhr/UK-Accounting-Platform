import { FEATURE_FLAGS, isFeatureKey, type FeatureKey } from '@uk/contracts';
import { notFound } from '@uk/core';
import type { Database, Tx } from '@uk/db';
import { auditRow } from './audit';

export type FlagSource = 'organisation' | 'environment' | 'default';
export interface FlagState { key: FeatureKey; description: string; enabled: boolean; source: FlagSource; overriddenAt?: Date; reason?: string | null }

/**
 * Feature flags: registry default < environment default < per-organisation override.
 * Reads are cached per process for `ttlMs` (default 5 s), so a change made on one instance reaches the others within that window;
 * changes made through this service invalidate the local cache immediately. Every change is audited with before/after and reason.
 */
export class FeatureFlagService {
  private readonly cache = new Map<string, { at: number; value: { enabled: boolean } | null }>();
  constructor(
    private readonly db: Database,
    private readonly envDefaults: Partial<Record<FeatureKey, boolean>> = {},
    private readonly opts: { ttlMs?: number; captureDeviceMetadata?: boolean } = {},
  ) {
    for (const k of Object.keys(envDefaults)) if (!isFeatureKey(k)) throw new Error(`Unknown feature flag in defaults: ${k}`);
  }

  private base(key: FeatureKey): { enabled: boolean; source: FlagSource } {
    const env = this.envDefaults[key];
    return env === undefined ? { enabled: FEATURE_FLAGS[key].default, source: 'default' } : { enabled: env, source: 'environment' };
  }

  private async override(organisationId: string, key: FeatureKey): Promise<{ enabled: boolean } | null> {
    const ck = `${organisationId}:${key}`, ttl = this.opts.ttlMs ?? 5000, hit = this.cache.get(ck);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const row = await this.db.tenant({ organisationId }, (tx) => tx.featureFlagOverride.findUnique({ where: { organisationId_key: { organisationId, key } }, select: { enabled: true } }));
    this.cache.set(ck, { at: Date.now(), value: row });
    return row;
  }

  async isEnabled(key: FeatureKey, organisationId: string): Promise<boolean> {
    return (await this.override(organisationId, key))?.enabled ?? this.base(key).enabled;
  }

  async list(organisationId: string): Promise<FlagState[]> {
    const rows = await this.db.tenant({ organisationId }, (tx) => tx.featureFlagOverride.findMany());
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return (Object.keys(FEATURE_FLAGS) as FeatureKey[]).map((key) => {
      const o = byKey.get(key);
      const b = this.base(key);
      return { key, description: FEATURE_FLAGS[key].description, enabled: o ? o.enabled : b.enabled, source: o ? 'organisation' as const : b.source, overriddenAt: o?.updatedAt, reason: o?.reason };
    });
  }

  private invalidate(organisationId: string, key: FeatureKey) { this.cache.delete(`${organisationId}:${key}`); }

  async set(tx: Tx, a: { organisationId: string; key: string; enabled: boolean; userId: string; reason?: string }): Promise<FlagState> {
    if (!isFeatureKey(a.key)) throw notFound('Unknown feature flag');
    const before = await tx.featureFlagOverride.findUnique({ where: { organisationId_key: { organisationId: a.organisationId, key: a.key } } });
    const effectiveBefore = before ? before.enabled : this.base(a.key).enabled;
    const saved = await tx.featureFlagOverride.upsert({
      where: { organisationId_key: { organisationId: a.organisationId, key: a.key } },
      create: { organisationId: a.organisationId, key: a.key, enabled: a.enabled, reason: a.reason, setByUserId: a.userId }, update: { enabled: a.enabled, reason: a.reason, setByUserId: a.userId },
    });
    await tx.auditEvent.createMany({ data: [auditRow({ action: 'feature_flag.set', organisationId: a.organisationId, actorUserId: a.userId, entityType: 'feature_flag', entityId: a.key,
      before: { enabled: effectiveBefore, source: before ? 'organisation' : this.base(a.key).source }, after: { enabled: a.enabled, source: 'organisation' }, reason: a.reason }, this.opts.captureDeviceMetadata ?? true)] });
    this.invalidate(a.organisationId, a.key);
    // Built from the row we just wrote: a second connection could not see this transaction's uncommitted change.
    return { key: a.key, description: FEATURE_FLAGS[a.key].description, enabled: saved.enabled, source: 'organisation', overriddenAt: saved.updatedAt, reason: saved.reason };
  }

  /** Remove the organisation override: the flag falls back to the environment / registry default. */
  async clear(tx: Tx, a: { organisationId: string; key: string; userId: string; reason?: string }): Promise<void> {
    if (!isFeatureKey(a.key)) throw notFound('Unknown feature flag');
    const before = await tx.featureFlagOverride.findUnique({ where: { organisationId_key: { organisationId: a.organisationId, key: a.key } } });
    if (!before) return;
    await tx.featureFlagOverride.delete({ where: { organisationId_key: { organisationId: a.organisationId, key: a.key } } });
    await tx.auditEvent.createMany({ data: [auditRow({ action: 'feature_flag.cleared', organisationId: a.organisationId, actorUserId: a.userId, entityType: 'feature_flag', entityId: a.key,
      before: { enabled: before.enabled, source: 'organisation' }, after: { enabled: this.base(a.key).enabled, source: this.base(a.key).source }, reason: a.reason }, this.opts.captureDeviceMetadata ?? true)] });
    this.invalidate(a.organisationId, a.key);
  }
}
