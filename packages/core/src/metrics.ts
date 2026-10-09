/**
 * Minimal in-process metrics (ADR-35): counters, gauges and histograms with BOUNDED labels, rendered as Prometheus text or as
 * CloudWatch Embedded Metric Format (EMF) log lines. No dependency, no agent. Labels must come from small fixed sets (route
 * templates, methods, status classes, queue and status names) - never from ids, e-mails or free text; `labelsOk` enforces the shape
 * and the registry caps the number of distinct series so a bug cannot create unbounded cardinality.
 */
export type Labels = Record<string, string>;
type Kind = 'counter' | 'gauge' | 'histogram';

interface Series { labels: Labels; value: number; buckets?: number[]; sum?: number; count?: number; emitted?: number; emittedCount?: number; emittedSum?: number }
interface Metric { name: string; help: string; kind: Kind; unit: string; bounds?: number[]; series: Map<string, Series> }

export const MAX_SERIES_PER_METRIC = 500;
const NAME = /^[a-z][a-z0-9_]*$/;
const LABEL_VALUE = /^[A-Za-z0-9_.:{}\-/ *]{0,120}$/;
export const labelsOk = (l: Labels): boolean => Object.entries(l).every(([k, v]) => NAME.test(k) && LABEL_VALUE.test(v) && !/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v) && !v.includes('?'));

const key = (l: Labels) => Object.keys(l).sort().map((k) => `${k}=${l[k]}`).join(',');
const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const fmt = (l: Labels, extra: Labels = {}) => {
  const all = { ...l, ...extra };
  const parts = Object.keys(all).sort().map((k) => `${k}="${esc(all[k]!)}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
};

export class MetricsRegistry {
  private readonly metrics = new Map<string, Metric>();
  /** Series refused because of a bad label or the cardinality cap (itself exported, so the problem is visible). */
  private dropped = 0;

  private metric(name: string, help: string, kind: Kind, unit = 'None', bounds?: number[]): Metric {
    if (!NAME.test(name)) throw new Error(`invalid metric name ${name}`);
    let m = this.metrics.get(name);
    if (!m) { m = { name, help, kind, unit, bounds, series: new Map() }; this.metrics.set(name, m); }
    if (m.kind !== kind) throw new Error(`metric ${name} is a ${m.kind}`);
    return m;
  }

  private slot(m: Metric, labels: Labels): Series | null {
    if (!labelsOk(labels)) { this.dropped++; return null; }
    const k = key(labels);
    let s = m.series.get(k);
    if (!s) {
      if (m.series.size >= MAX_SERIES_PER_METRIC) { this.dropped++; return null; }
      s = { labels, value: 0, ...(m.bounds ? { buckets: m.bounds.map(() => 0), sum: 0, count: 0 } : {}) };
      m.series.set(k, s);
    }
    return s;
  }

  inc(name: string, help: string, labels: Labels = {}, by = 1): void {
    const s = this.slot(this.metric(name, help, 'counter', 'Count'), labels);
    if (s) s.value += by;
  }

  set(name: string, help: string, value: number, labels: Labels = {}, unit = 'None'): void {
    const m = this.metric(name, help, 'gauge', unit);
    if (!Number.isFinite(value)) return;
    const s = this.slot(m, labels);
    if (s) s.value = value;
  }

  observe(name: string, help: string, value: number, labels: Labels = {}, bounds: number[] = [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]): void {
    const m = this.metric(name, help, 'histogram', 'Seconds', bounds);
    if (!Number.isFinite(value)) return;
    const s = this.slot(m, labels);
    if (!s) return;
    m.bounds!.forEach((b, i) => { if (value <= b) s.buckets![i]!++; });
    s.sum! += value; s.count!++;
  }

  /** Current value of one series (tests, readiness). */
  value(name: string, labels: Labels = {}): number | undefined { return this.metrics.get(name)?.series.get(key(labels))?.value; }
  droppedSeries(): number { return this.dropped; }

  /** Prometheus text exposition format. */
  renderPrometheus(): string {
    const out: string[] = [];
    for (const m of [...this.metrics.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      out.push(`# HELP ${m.name} ${m.help}`, `# TYPE ${m.name} ${m.kind}`);
      for (const s of m.series.values()) {
        if (m.kind === 'histogram') {
          m.bounds!.forEach((b, i) => out.push(`${m.name}_bucket${fmt(s.labels, { le: String(b) })} ${s.buckets![i]}`));
          out.push(`${m.name}_bucket${fmt(s.labels, { le: '+Inf' })} ${s.count}`, `${m.name}_sum${fmt(s.labels)} ${s.sum}`, `${m.name}_count${fmt(s.labels)} ${s.count}`);
        } else out.push(`${m.name}${fmt(s.labels)} ${s.value}`);
      }
    }
    out.push('# HELP metrics_dropped_series_total Series refused (bad label or cardinality cap)', '# TYPE metrics_dropped_series_total counter', `metrics_dropped_series_total ${this.dropped}`);
    return out.join('\n') + '\n';
  }

  /**
   * CloudWatch Embedded Metric Format: one JSON object per (metric, dimension set) written to the log stream; CloudWatch extracts the
   * metrics from the log lines. Counters are emitted as the increase since the previous call (so alarms use `Sum`); gauges as their value;
   * histograms as the increase in count and sum. `dimensionKeys` limits the dimensions kept (everything else is aggregated away).
   */
  renderEmf(opts: { namespace: string; service: string; now?: number; dimensionKeys?: string[] }): string[] {
    const ts = opts.now ?? Date.now();
    const lines: string[] = [];
    const keep = opts.dimensionKeys;
    for (const m of this.metrics.values()) {
      const groups = new Map<string, { dims: Labels; value: number; sum: number; count: number }>();
      for (const s of m.series.values()) {
        const dims: Labels = {};
        for (const k of Object.keys(s.labels)) if (!keep || keep.includes(k)) dims[k] = s.labels[k]!;
        const g = groups.get(key(dims)) ?? { dims, value: 0, sum: 0, count: 0 };
        if (m.kind === 'gauge') g.value += s.value;
        else if (m.kind === 'counter') { g.value += s.value - (s.emitted ?? 0); s.emitted = s.value; }      // the increase since the previous line
        else { g.count += (s.count ?? 0) - (s.emittedCount ?? 0); g.sum += (s.sum ?? 0) - (s.emittedSum ?? 0); s.emittedCount = s.count; s.emittedSum = s.sum; }
        groups.set(key(dims), g);
      }
      for (const g of groups.values()) {
        const dimNames = ['service', ...Object.keys(g.dims)];
        const metricDefs = m.kind === 'histogram'
          ? [{ Name: `${m.name}_count`, Unit: 'Count' }, { Name: `${m.name}_sum`, Unit: 'Seconds' }]
          : [{ Name: m.name, Unit: m.unit }];
        const body: Record<string, unknown> = { _aws: { Timestamp: ts, CloudWatchMetrics: [{ Namespace: opts.namespace, Dimensions: [dimNames], Metrics: metricDefs }] }, service: opts.service, ...g.dims };
        if (m.kind === 'histogram') { body[`${m.name}_count`] = g.count; body[`${m.name}_sum`] = g.sum; } else body[m.name] = g.value;
        lines.push(JSON.stringify(body));
      }
    }
    return lines;
  }
}

/** Event-loop lag and memory, sampled by whoever owns the process. */
export function sampleProcess(reg: MetricsRegistry, lagSeconds: number): void {
  const mem = process.memoryUsage();
  reg.set('process_event_loop_lag_seconds', 'Event loop lag', lagSeconds, {}, 'Seconds');
  reg.set('process_resident_memory_bytes', 'Resident set size', mem.rss, {}, 'Bytes');
  reg.set('process_heap_used_bytes', 'Heap used', mem.heapUsed, {}, 'Bytes');
}

/** Measures event-loop lag by timer drift. Returns a stop function. */
export function startLagSampler(reg: MetricsRegistry, intervalMs = 5000): () => void {
  sampleProcess(reg, 0); // series exist from the first scrape
  let last = process.hrtime.bigint();
  const t = setInterval(() => {
    const now = process.hrtime.bigint();
    const lag = Math.max(0, Number(now - last) / 1e9 - intervalMs / 1000);
    last = now;
    sampleProcess(reg, lag);
  }, intervalMs);
  t.unref();
  return () => clearInterval(t);
}

/** Writes the registry as EMF lines to `write` (stdout by default: the ECS log driver ships it to CloudWatch). Returns a stop function. */
export function startEmfEmitter(reg: MetricsRegistry, o: { namespace: string; service: string; intervalMs: number; dimensionKeys?: string[]; write?: (line: string) => void; before?: () => Promise<void> | void }): () => void {
  const write = o.write ?? ((l: string) => { process.stdout.write(`${l}\n`); });
  const t = setInterval(() => {
    void (async () => {
      try { await o.before?.(); } catch { /* a failed collection must not stop the heartbeat */ }
      for (const line of reg.renderEmf({ namespace: o.namespace, service: o.service, dimensionKeys: o.dimensionKeys })) write(line);
    })();
  }, o.intervalMs);
  t.unref();
  return () => clearInterval(t);
}

/** Dimension keys kept in EMF output: bounded sets only (everything else, e.g. route, is aggregated away to keep CloudWatch cost and cardinality sane). */
export const EMF_DIMENSION_KEYS = ['status', 'status_class', 'queue', 'reason'];
