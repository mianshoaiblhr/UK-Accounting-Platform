'use client';
import { useState } from 'react';
import { ApiError } from '@/lib/api';

/**
 * The three refusals the API lets a person override with a reason (M9b): possible duplicate, credit limit, cash in hand below zero. The screen shows
 * the API's message and a reason box; the request is repeated with the reason in the field the API names. Any other refusal is not handled here.
 */
export const OVERRIDE_FIELDS: Record<string, string> = { possible_duplicate: 'duplicateOverrideReason', credit_limit_exceeded: 'creditLimitOverrideReason', negative_cash: 'negativeCashReason' };

export function useOverrides(fields: Record<string, string> = OVERRIDE_FIELDS) {
  const [pending, setPending] = useState<{ code: string; field: string; message: string }[]>([]);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  /** true when the error is one of the overridable refusals (it is then shown with a reason box). */
  const take = (e: unknown) => {
    if (!(e instanceof ApiError) || !fields[e.code]) return false;
    const field = fields[e.code]!;
    setPending((x) => [...x.filter((p) => p.code !== e.code), { code: e.code, field, message: e.message }]);
    return true;
  };
  const body = () => Object.fromEntries(Object.entries(reasons).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()]));
  const reset = () => { setPending([]); setReasons({}); };
  const view = (
    <>
      {pending.map((p) => (
        <div key={p.code} role="alert" data-override={p.code}>
          <p className="error">{p.message}</p>
          <label htmlFor={`ov-${p.code}`}>Reason to go ahead</label>
          <input id={`ov-${p.code}`} value={reasons[p.field] ?? ''} onChange={(e) => setReasons({ ...reasons, [p.field]: e.target.value })} />
        </div>
      ))}
    </>
  );
  return { take, body, reset, view };
}
