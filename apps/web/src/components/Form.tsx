'use client';
import { useState, type FormEvent, type ReactNode } from 'react';
import { errorText } from '@/lib/api';

/** Small form shell: busy state + error/success display. */
export function Form({ onSubmit, submit, children, success }: {
  onSubmit: () => Promise<string | void>; submit: string; children: ReactNode; success?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  async function handle(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(''); setDone('');
    try { const msg = await onSubmit(); setDone(msg || success || ''); } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }
  return (
    <form onSubmit={handle}>
      {children}
      <button type="submit" disabled={busy}>{busy ? 'Please wait…' : submit}</button>
      {error && <p className="error" role="alert">{error}</p>}
      {done && <p className="ok" role="status">{done}</p>}
    </form>
  );
}

export function Field({ label, value, onChange, type = 'text', name, autoComplete }: {
  label: string; value: string; onChange: (v: string) => void; type?: string; name: string; autoComplete?: string;
}) {
  return (
    <>
      <label htmlFor={name}>{label}</label>
      <input id={name} name={name} type={type} value={value} autoComplete={autoComplete} onChange={(e) => onChange(e.target.value)} required />
    </>
  );
}
