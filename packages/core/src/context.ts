import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestContext {
  correlationId: string;
  userId?: string;
  organisationId?: string;
  ip?: string;
  userAgent?: string;
}

const als = new AsyncLocalStorage<RequestContext>();

export const runWithContext = <T>(ctx: RequestContext, fn: () => T): T => als.run(ctx, fn);
export const getContext = (): RequestContext | undefined => als.getStore();
export const getCorrelationId = (): string => als.getStore()?.correlationId ?? randomUUID();
/** Merge extra fields into the current context (e.g. once the user is authenticated). */
export const patchContext = (patch: Partial<RequestContext>): void => {
  const store = als.getStore();
  if (store) Object.assign(store, patch);
};
