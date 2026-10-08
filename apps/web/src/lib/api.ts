export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public errors?: { path: string; message: string }[]) {
    super(message);
  }
}

/** Thin fetch wrapper: same-origin, cookie session, RFC 9457 errors. */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    credentials: 'same-origin',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.idempotencyKey ? { 'Idempotency-Key': init.idempotencyKey } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, data?.code ?? 'error', data?.title ?? res.statusText, data?.errors);
  return data as T;
}

export const errorText = (e: unknown): string =>
  e instanceof ApiError ? (e.errors?.length ? e.errors.map((x) => `${x.path}: ${x.message}`).join('; ') : e.message) : 'Something went wrong';

export interface Me {
  user: { id: string; email: string; displayName: string };
  mfa: { enabled: boolean; recoveryCodesRemaining: number };
  organisations: { id: string; name: string; type: 'PRACTICE' | 'BUSINESS'; role: string; roleName: string }[];
}
export interface Company { id: string; name: string; companyNumber: string | null; legalForm: string }
