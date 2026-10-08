import { z } from 'zod';
import type { AppConfig } from '@uk/core';
import { FakeAiProvider, type AiProvider } from './ai';
import { IntegrationRegistry, type IntegrationAdapter } from './integrations';

/** Development/test adapter that proves the abstraction end to end. NEVER registered in production. */
export class MockIntegrationAdapter implements IntegrationAdapter<z.ZodObject<{ apiKey: z.ZodString }>> {
  readonly provider = 'mock';
  readonly displayName = 'Mock provider (development only)';
  readonly capabilities = ['ping', 'echo'] as const;
  readonly allowedHosts = ['api.mock.example'] as const;
  readonly credentialSchema = z.object({ apiKey: z.string().min(8) });
  async healthCheck(c: { apiKey: string }) { return c.apiKey.startsWith('bad') ? { ok: false, detail: 'rejected by provider' } : { ok: true }; }
  async execute(op: string, params: Record<string, unknown>) { return op === 'ping' ? { pong: true } : { echo: params }; }
}

export const createIntegrationRegistry = (c: AppConfig): IntegrationRegistry => {
  const r = new IntegrationRegistry();
  if (!c.isProduction) r.register(new MockIntegrationAdapter());
  // Later versions register HMRC / Companies House / bank adapters here — and nowhere else.
  return r;
};

export const createAiProviders = (c: AppConfig): AiProvider[] => (c.isProduction ? [] : [new FakeAiProvider()]);
