import { isIP } from 'node:net';
import type { ZodTypeAny, z } from 'zod';
import { FieldEncryption, notFound, unprocessable } from '@uk/core';
import type { Tx } from '@uk/db';

/** Minimal, SSRF-safe outbound HTTP handed to adapters. Adapters never get raw network access. */
export interface SafeHttp {
  request(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }): Promise<{ status: number; body: string }>;
}

const PRIVATE = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./, /^::1$/, /^fc/i, /^fd/i, /^fe80/i, /^localhost$/i];

export function createSafeHttp(allowedHosts: string[], fetchImpl: typeof fetch = fetch): SafeHttp {
  return {
    async request(url, init = {}) {
      const u = new URL(url);
      if (u.protocol !== 'https:') throw unprocessable('Only https is allowed for integrations', 'ssrf_blocked');
      const host = u.hostname.replace(/^\[|\]$/g, '');
      if (isIP(host) || PRIVATE.some((p) => p.test(host))) throw unprocessable('Direct/private addresses are not allowed', 'ssrf_blocked');
      if (!allowedHosts.includes(host)) throw unprocessable(`Host ${host} is not on the integration allow-list`, 'ssrf_blocked');
      const res = await fetchImpl(url, { method: init.method ?? 'GET', headers: init.headers, body: init.body, redirect: 'error', signal: AbortSignal.timeout(init.timeoutMs ?? 15_000) });
      const text = await res.text();
      return { status: res.status, body: text.slice(0, 1_000_000) };
    },
  };
}

/**
 * Port every external system (banks, HMRC, Companies House, accounting imports…) is reached through.
 * Business modules depend on this interface and the registry — never on a provider SDK or HTTP details.
 */
export interface IntegrationAdapter<S extends ZodTypeAny = ZodTypeAny> {
  readonly provider: string;
  readonly displayName: string;
  readonly capabilities: readonly string[];
  /** Hosts this adapter may call (enforced by SafeHttp). */
  readonly allowedHosts: readonly string[];
  readonly credentialSchema: S;
  healthCheck(credentials: z.output<S>, http: SafeHttp): Promise<{ ok: boolean; detail?: string }>;
  execute(operation: string, params: Record<string, unknown>, credentials: z.output<S>, http: SafeHttp): Promise<unknown>;
}

export class IntegrationRegistry {
  private readonly adapters = new Map<string, IntegrationAdapter>();
  register(a: IntegrationAdapter): this {
    if (this.adapters.has(a.provider)) throw new Error(`integration ${a.provider} already registered`);
    this.adapters.set(a.provider, a);
    return this;
  }
  get(provider: string): IntegrationAdapter {
    const a = this.adapters.get(provider);
    if (!a) throw unprocessable(`Unknown integration provider ${provider}`, 'unknown_provider');
    return a;
  }
  list() { return [...this.adapters.values()].map((a) => ({ provider: a.provider, displayName: a.displayName, capabilities: [...a.capabilities] })); }
}

export class IntegrationService {
  constructor(private readonly registry: IntegrationRegistry, private readonly crypto: FieldEncryption, private readonly http: (a: IntegrationAdapter) => SafeHttp = (a) => createSafeHttp([...a.allowedHosts])) {}

  providers() { return this.registry.list(); }

  private view(c: { id: string; provider: string; displayName: string; status: string; companyId: string | null; scopes: string[]; createdAt: Date; lastCheckedAt: Date | null; lastError: string | null }) {
    // credentials are deliberately absent from every outward representation
    return { id: c.id, provider: c.provider, displayName: c.displayName, status: c.status, companyId: c.companyId, scopes: c.scopes, createdAt: c.createdAt, lastCheckedAt: c.lastCheckedAt, lastError: c.lastError };
  }

  async create(tx: Tx, a: { organisationId: string; userId: string; provider: string; displayName: string; companyId?: string; credentials: unknown }) {
    const adapter = this.registry.get(a.provider);
    const parsed = adapter.credentialSchema.safeParse(a.credentials);
    if (!parsed.success) throw unprocessable('Invalid credentials for provider', 'invalid_credentials_shape', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    const row = await tx.integrationConnection.create({
      data: { organisationId: a.organisationId, companyId: a.companyId, provider: a.provider, displayName: a.displayName, scopes: [...adapter.capabilities],
        credentialsEncrypted: this.crypto.encrypt(JSON.stringify(parsed.data), `integration:${a.organisationId}`), createdByUserId: a.userId },
    });
    return this.view(row);
  }

  async list(tx: Tx) { return (await tx.integrationConnection.findMany({ where: { status: { not: 'REVOKED' } }, orderBy: { createdAt: 'desc' } })).map((c) => this.view(c)); }

  async revoke(tx: Tx, id: string) {
    const r = await tx.integrationConnection.updateMany({ where: { id, status: { not: 'REVOKED' } }, data: { status: 'REVOKED', credentialsEncrypted: null } });
    if (r.count !== 1) throw notFound('Connection not found');
  }

  private async load(tx: Tx, id: string, organisationId: string) {
    const c = await tx.integrationConnection.findUnique({ where: { id } });
    if (!c || c.status !== 'ACTIVE' || !c.credentialsEncrypted) throw notFound('Connection not found');
    const adapter = this.registry.get(c.provider);
    return { c, adapter, creds: JSON.parse(this.crypto.decrypt(c.credentialsEncrypted, `integration:${organisationId}`)) };
  }

  async check(tx: Tx, id: string, organisationId: string) {
    const { c, adapter, creds } = await this.load(tx, id, organisationId);
    const res = await adapter.healthCheck(creds, this.http(adapter));
    await tx.integrationConnection.update({ where: { id }, data: { lastCheckedAt: new Date(), lastError: res.ok ? null : (res.detail ?? 'unhealthy').slice(0, 500), status: res.ok ? 'ACTIVE' : 'ERROR' } });
    return { ...res, provider: c.provider };
  }

  async execute(tx: Tx, id: string, organisationId: string, operation: string, params: Record<string, unknown>) {
    const { adapter, creds } = await this.load(tx, id, organisationId);
    if (!adapter.capabilities.includes(operation)) throw unprocessable(`Operation ${operation} is not supported by ${adapter.provider}`, 'unsupported_operation');
    return adapter.execute(operation, params, creds, this.http(adapter));
  }
}
