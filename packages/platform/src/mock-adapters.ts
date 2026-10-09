import { z } from 'zod';
import type { AppConfig } from '@uk/core';
import { FakeAiProvider, type AiProvider } from './ai';
import { IntegrationRegistry, type IntegrationAdapter } from './integrations';

/** Development/test adapter that proves the abstraction end to end. NEVER registered in production. */
export class MockIntegrationAdapter implements IntegrationAdapter<z.ZodObject<{ apiKey: z.ZodString }>> {
  readonly provider = 'mock';
  readonly displayName = 'Mock provider (development only)';
  readonly capabilities = ['ping', 'echo', 'flaky'] as const;
  /** Attempts seen per `flaky` key (process-local; the adapter is never registered in production). */
  private readonly flakyAttempts = new Map<string, number>();
  readonly allowedHosts = ['api.mock.example'] as const;
  readonly credentialSchema = z.object({ apiKey: z.string().min(8) });
  async healthCheck(c: { apiKey: string }) { return c.apiKey.startsWith('bad') ? { ok: false, detail: 'rejected by provider' } : { ok: true }; }
  async execute(op: string, params: Record<string, unknown>) {
    if (op === 'flaky') {
      // Simulates a provider outage: the first `failTimes` calls for a key fail with a transient (retryable) error, then it recovers.
      const key = String(params.key ?? 'default');
      const n = (this.flakyAttempts.get(key) ?? 0) + 1;
      this.flakyAttempts.set(key, n);
      if (n <= Number(params.failTimes ?? 1)) throw new Error(`mock provider temporarily unavailable (call ${n})`);
      return { recovered: true, calls: n };
    }
    return op === 'ping' ? { pong: true } : { echo: params };
  }
}

export const createIntegrationRegistry = (c: AppConfig): IntegrationRegistry => {
  const r = new IntegrationRegistry();
  if (!c.isProduction) r.register(new MockIntegrationAdapter());
  // Later versions register HMRC / Companies House / bank adapters here — and nowhere else.
  return r;
};

export const createAiProviders = (c: AppConfig): AiProvider[] => (c.isProduction ? [] : [new FakeAiProvider()]);
