import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMF_DIMENSION_KEYS } from '../../packages/core/src/metrics';

/** Drift guard between the application's metrics and the CloudWatch alarms that depend on them (Terraform is validated in CI, never applied here). */
const ROOT = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const tf = read('infra/terraform/observability.tf');
const code = [read('packages/platform/src/metrics.ts'), read('apps/api/src/common/access-log.middleware.ts'), read('apps/worker/src/worker.ts')].join('\n');

const alarms = [...tf.matchAll(/metric\s*=\s*"([a-z_]+)"\s*\n\s*dimensions\s*=\s*\{([^}]*)\}/g)].map((m) => ({ metric: m[1]!, dims: [...m[2]!.matchAll(/(\w+)\s*=\s*"([^"]+)"/g)].map((d) => ({ key: d[1]!, value: d[2]! })) }));

describe('alarms match the metrics the application emits', () => {
  it('finds the custom alarms', () => expect(alarms.length).toBeGreaterThanOrEqual(8));
  it('every alarmed metric name is produced by the code', () => {
    for (const a of alarms) expect(code, a.metric).toContain(`'${a.metric}'`);
  });
  it('every alarm dimension is a dimension the EMF output actually keeps (or the service)', () => {
    for (const a of alarms) for (const d of a.dims) expect(['service', ...EMF_DIMENSION_KEYS], `${a.metric}.${d.key}`).toContain(d.key);
  });
  it('the worker heartbeat alarm treats missing data as breaching (a silent worker alarms)', () => {
    expect(tf).toMatch(/worker_silent = \{[\s\S]*?missing\s*=\s*"breaching"/);
  });
  it('services emit EMF in production: METRICS_EMF is set for every service', () => {
    expect(read('infra/terraform/compute.tf')).toContain('{ name = "METRICS_EMF", value = "true" }');
  });
  it('alarms notify a topic, recover to it, and alarm on the outbox, dead jobs, 5xx, logins, ALB, ECS and RDS', () => {
    for (const k of ['outbox_failed', 'outbox_lag', 'jobs_dead', 'api_5xx', 'login_rejected_burst', 'alb_5xx', 'ecs_cpu', 'ecs_memory', 'rds_cpu', 'rds_connections', 'rds_storage', 'unhealthy_targets']) expect(tf, k).toContain(k);
    expect(tf).toContain('alarm_actions');
    expect(tf).toContain('ok_actions');
  });
});
