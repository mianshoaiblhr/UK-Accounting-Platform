import { Prisma, PrismaClient } from '@prisma/client';

export * from '@prisma/client';
export type Tx = Prisma.TransactionClient;

export interface TenantContext {
  organisationId: string;
  userId?: string;
}

const TX_OPTS = { maxWait: 5_000, timeout: 30_000 } as const;

/**
 * The ONLY sanctioned way to touch tenant data. Each call opens a transaction and sets transaction-local
 * settings that PostgreSQL row-level-security policies read (`app.organisation_id`, `app.user_id`).
 * Without a context every tenant table returns zero rows and rejects writes (fail closed).
 */
export class Database {
  readonly prisma: PrismaClient;

  constructor(url: string, log: Prisma.LogLevel[] = ['warn']) {
    this.prisma = new PrismaClient({ datasourceUrl: url, log });
  }

  private async scoped<T>(settings: Record<string, string>, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      for (const [k, v] of Object.entries(settings)) {
        await tx.$executeRaw`SELECT set_config(${k}, ${v}, true)`;
      }
      return fn(tx);
    }, TX_OPTS);
  }

  /** Run inside one organisation's tenant context. */
  tenant<T>(ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (!ctx.organisationId) throw new Error('organisationId is required for a tenant context');
    return this.scoped({ 'app.organisation_id': ctx.organisationId, 'app.user_id': ctx.userId ?? '' }, fn);
  }

  /** User-only context: lets a user see their own memberships / pre-tenant audit events. */
  asUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.scoped({ 'app.user_id': userId }, fn);
  }

  /** Trusted cross-tenant context (invitation token lookup, job sweeper, pre-auth audit). Use sparingly. */
  system<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.scoped({ 'app.system': 'on' }, fn);
  }

  async ping(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
export * from './classification';
