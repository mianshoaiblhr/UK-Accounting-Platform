import { describe, expect, it } from 'vitest';
import { MAX_SERIES_PER_METRIC, MetricsRegistry, labelsOk } from './metrics';

describe('MetricsRegistry', () => {
  it('counts, sets and observes; renders Prometheus text with sorted labels and histogram buckets', () => {
    const r = new MetricsRegistry();
    r.inc('http_requests_total', 'Requests', { method: 'GET', route: '/api/v1/x/:id', status_class: '2xx' });
    r.inc('http_requests_total', 'Requests', { method: 'GET', route: '/api/v1/x/:id', status_class: '2xx' }, 2);
    r.set('outbox_pending', 'Pending', 7);
    r.observe('http_request_duration_seconds', 'Latency', 0.03, { route: '/a' });
    r.observe('http_request_duration_seconds', 'Latency', 3, { route: '/a' });
    const text = r.renderPrometheus();
    expect(text).toContain('# TYPE http_requests_total counter');
    expect(text).toContain('http_requests_total{method="GET",route="/api/v1/x/:id",status_class="2xx"} 3');
    expect(text).toContain('outbox_pending 7');
    expect(text).toContain('http_request_duration_seconds_bucket{le="0.1",route="/a"} 1');
    expect(text).toContain('http_request_duration_seconds_bucket{le="+Inf",route="/a"} 2');
    expect(text).toContain('http_request_duration_seconds_count{route="/a"} 2');
    expect(r.value('outbox_pending')).toBe(7);
  });

  it('refuses unbounded or sensitive labels (ids, query strings, e-mails) and caps cardinality, and exports how many it dropped', () => {
    const r = new MetricsRegistry();
    r.inc('c_total', 'c', { route: '/orgs/0190a5b6-1234-7abc-8def-0123456789ab/tasks' });
    r.inc('c_total', 'c', { route: '/x?token=abc' });
    r.inc('c_total', 'c', { Bad: 'x' });
    r.inc('c_total', 'c', { who: 'alice@example.com' });
    expect(r.value('c_total', { route: '/x?token=abc' })).toBeUndefined();
    for (let i = 0; i < MAX_SERIES_PER_METRIC + 10; i++) r.inc('many_total', 'm', { n: `v${i}` });
    expect(r.renderPrometheus()).toMatch(/metrics_dropped_series_total (\d+)/);
    expect(r.droppedSeries()).toBeGreaterThanOrEqual(14);
    expect(labelsOk({ route: '/api/v1/organisations/:organisationId/tasks/:taskId', status_class: '2xx' })).toBe(true);
  });

  it('rejects invalid or mismatched metric definitions', () => {
    const r = new MetricsRegistry();
    expect(() => r.inc('Bad-Name', 'x')).toThrow(/invalid metric name/);
    r.inc('a_total', 'a');
    expect(() => r.set('a_total', 'a', 1)).toThrow(/is a counter/);
  });

  it('ignores non-finite values', () => {
    const r = new MetricsRegistry();
    r.set('g', 'g', Number.NaN);
    r.observe('h_seconds', 'h', Number.POSITIVE_INFINITY);
    expect(r.value('g')).toBeUndefined();
  });

  it('renders CloudWatch Embedded Metric Format: one valid JSON line per metric and dimension set', () => {
    const r = new MetricsRegistry();
    r.set('outbox_failed', 'Failed outbox events', 2);
    r.set('jobs', 'Jobs by status', 3, { status: 'DEAD', queue: 'documents' });
    r.set('jobs', 'Jobs by status', 4, { status: 'DEAD', queue: 'ai' });
    r.inc('http_requests_total', 'r', { route: '/a', status_class: '5xx', method: 'GET' }, 5);
    r.observe('http_request_duration_seconds', 'l', 0.2, { route: '/a' });
    const lines = r.renderEmf({ namespace: 'UkPlatform', service: 'worker', now: 1_700_000_000_000, dimensionKeys: ['status', 'status_class'] }).map((l) => JSON.parse(l));
    const by = (m: string) => lines.filter((l) => l[m] !== undefined);
    expect(by('outbox_failed')[0]).toMatchObject({ outbox_failed: 2, service: 'worker', _aws: { Timestamp: 1_700_000_000_000, CloudWatchMetrics: [{ Namespace: 'UkPlatform', Dimensions: [['service']], Metrics: [{ Name: 'outbox_failed', Unit: 'None' }] }] } });
    expect(by('jobs')).toHaveLength(1);                       // queue dimension aggregated away
    expect(by('jobs')[0]).toMatchObject({ jobs: 7, status: 'DEAD', _aws: { CloudWatchMetrics: [{ Dimensions: [['service', 'status']] }] } });
    expect(by('http_requests_total')[0]).toMatchObject({ http_requests_total: 5, status_class: '5xx' });
    expect(by('http_request_duration_seconds_count')[0]).toMatchObject({ http_request_duration_seconds_count: 1 });
    // counters are deltas: a second call with no new events reports 0, new events report only the increase
    r.inc('http_requests_total', 'r', { route: '/a', status_class: '5xx', method: 'GET' }, 2);
    const again = r.renderEmf({ namespace: 'UkPlatform', service: 'worker', dimensionKeys: ['status_class'] }).map((l) => JSON.parse(l));
    expect(again.find((l) => l.http_requests_total !== undefined)).toMatchObject({ http_requests_total: 2 });
    expect(r.renderEmf({ namespace: 'UkPlatform', service: 'worker', dimensionKeys: ['status_class'] }).map((l) => JSON.parse(l)).find((l) => l.http_requests_total !== undefined)).toMatchObject({ http_requests_total: 0 });
    for (const l of lines) expect(l._aws.CloudWatchMetrics[0].Metrics.length).toBeLessThanOrEqual(100);
  });
});
