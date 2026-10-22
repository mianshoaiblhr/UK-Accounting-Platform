'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { api, errorText } from '@/lib/api';
import { qs, useApi, useWorkspace } from '@/lib/workspace';

/**
 * V2-M7b (DEC-074): shared parts of the register screens. Lists, figures, schedules, previews and reconciliations are the API's; these
 * helpers only offer choices (accounts, contacts) and send what the person enters, showing a refusal in the API's words.
 */
export interface Account { id: string; code: string; name: string; type: string; isControl: boolean; activeTo: string | null }
export const today = () => new Date().toISOString().slice(0, 10);

const PAGES = [
  { href: '', label: 'Fixed assets' },
  { href: '/depreciation', label: 'Depreciation' },
  { href: '/adjustments', label: 'Adjustments' },
  { href: '/provisions', label: 'Provisions' },
  { href: '/close', label: 'Closing journal' },
  { href: '/directors', label: 'Directors' },
  { href: '/related-parties', label: 'Related parties' },
];

export function RegistersNav() {
  const w = useWorkspace();
  const pathname = usePathname();
  const base = `${w.base}/registers`;
  return (
    <p className="muted" data-testid="registers-nav">
      {PAGES.map((p, i) => <span key={p.href}>{i > 0 && ' · '}{pathname === `${base}${p.href}` ? <strong>{p.label}</strong> : <Link href={`${base}${p.href}`}>{p.label}</Link>}</span>)}
    </p>
  );
}

/** The company's accounts, for choosing; `filter` narrows the choice (the API still checks every account it is sent). */
export function useAccounts() {
  const w = useWorkspace();
  const { data } = useApi<{ items: Account[] }>(w.path('/accounts'));
  const items = (data?.items ?? []).filter((a) => !a.activeTo);
  return { items, label: (id: string | null | undefined) => { const a = items.find((x) => x.id === id); return a ? `${a.code} ${a.name}` : id ?? ''; } };
}

export function AccountSelect({ id, label, value, onChange, filter, required = true }: { id: string; label: string; value: string; onChange: (v: string) => void; filter?: (a: Account) => boolean; required?: boolean }) {
  const { items } = useAccounts();
  return (
    <div>
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} required={required}>
        <option value="">Choose an account</option>
        {items.filter(filter ?? (() => true)).map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
      </select>
    </div>
  );
}

export function ContactSelect({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  const w = useWorkspace();
  const { data } = useApi<{ items: { id: string; name: string }[] }>(`/organisations/${w.orgId}/contacts${qs({ limit: '100' })}`);
  return (
    <div>
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} required>
        <option value="">Choose a contact</option>
        {(data?.items ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
    </div>
  );
}

export function Input({ id, label, value, onChange, type = 'text', required = true, placeholder }: { id: string; label: string; value: string; onChange: (v: string) => void; type?: string; required?: boolean; placeholder?: string }) {
  return <div><label htmlFor={id}>{label}</label><input id={id} type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} required={required} /></div>;
}

/** An action that needs a reason (a reversal, a cancellation, an end): the reason box and the button, the API's refusal under them. */
export function ReasonAction({ label, path, extra, onDone, testId }: { label: string; path: string; extra?: Record<string, unknown>; onDone: () => Promise<void> | void; testId?: string }) {
  const w = useWorkspace();
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="inline-actions" data-testid={testId}>
      <input aria-label={`Reason to ${label.toLowerCase()}`} placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      <button className="secondary" disabled={busy} onClick={async () => {
        setBusy(true); setError('');
        try { await api(w.path(path), { body: { ...(extra ?? {}), reason: reason.trim() } }); setReason(''); await onDone(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
      }}>{label}</button>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

/** A labelled card with an optional heading action area. */
export function Card({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return <div className="card" data-testid={testId}><h2>{title}</h2>{children}</div>;
}

/** Reconciliation rows exactly as the API returns them. */
export function Reconciliation({ rows, reconciled }: { rows: { code: string; kind?: string; register: string; ledger: string; difference: string; reconciled: boolean }[]; reconciled: boolean }) {
  return (
    <>
      <p data-testid="reconciled" className={reconciled ? 'ok' : 'error'}>{reconciled ? 'The register reconciles to the ledger.' : 'The register does not reconcile to the ledger.'}</p>
      <table>
        <thead><tr><th>Account</th><th className="num">Register</th><th className="num">Ledger</th><th className="num">Difference</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={`${r.code}-${r.kind ?? ''}`}><td>{r.code}{r.kind ? ` (${r.kind.toLowerCase()})` : ''}</td><td className="num">{r.register}</td><td className="num">{r.ledger}</td><td className="num">{r.difference}</td></tr>)}</tbody>
      </table>
    </>
  );
}
