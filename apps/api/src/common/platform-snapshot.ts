import { collectPlatformSnapshot, applySnapshot, type PlatformSnapshot } from '@uk/platform';
import type { Database } from '@uk/db';
import type { MetricsRegistry } from '@uk/core';

/** Short-lived cache of the aggregate platform snapshot so probes and scrapes cannot load the database. */
export class PlatformSnapshotCache {
  private cached?: { at: number; snap: PlatformSnapshot };
  constructor(private readonly db: Database, private readonly metrics: MetricsRegistry, private readonly ttlMs = 10_000) {}
  async get(): Promise<PlatformSnapshot> {
    if (this.cached && Date.now() - this.cached.at < this.ttlMs) return this.cached.snap;
    const snap = await collectPlatformSnapshot(this.db);
    applySnapshot(this.metrics, snap);
    this.cached = { at: Date.now(), snap };
    return snap;
  }
}
