'use client';
import { useState, type FormEvent } from 'react';
import { api, errorText } from '@/lib/api';
import { qs, useApi, useWorkspace } from '@/lib/workspace';
import { useOverrides } from '../subledger/Overrides';
import type { Account } from '../subledger/side';
import { BankNav } from './BankAccounts';

interface Transfer { id: string; fromAccountId: string; toAccountId: string; transferDate: string; currency: string; amount: string; reference: string | null; description: string; status: string }
const isMoney = (a: Account) => a.subtype === 'CURRENT_ASSET_BANK' || a.subtype === 'CURRENT_ASSET_CASH';

/** Money moved between two bank or cash accounts of the company (M9c over DEC-041); reversal is a mirror with a reason. */
export function TransfersPage() {
  const w = useWorkspace();
  const list = useApi<{ items: Transfer[] }>(w.path(`/bank-transfers${qs({ limit: '200' })}`));
  const accounts = useApi<{ items: Account[] }>(w.can('account:read') ? w.path('/accounts') : null);
  const [f, setF] = useState({ fromAccountId: '', toAccountId: '', transferDate: new Date().toISOString().slice(0, 10), amount: '', description: '', reference: '' });
  const [msg, setMsg] = useState<{ ok?: string; error?: string }>({});
  const ov = useOverrides();
  const rev = useOverrides();
  const [revReason, setRevReason] = useState<Record<string, string>>({});
  const money = (accounts.data?.items ?? []).filter(isMoney);
  const name = (id: string) => { const a = money.find((x) => x.id === id); return a ? `${a.code} ${a.name}` : ''; };
  async function record(e: FormEvent) {
    e.preventDefault(); setMsg({});
    try {
      await api(w.path('/bank-transfers'), { body: { ...f, reference: f.reference || undefined, ...ov.body() }, idempotencyKey: crypto.randomUUID() });
      ov.reset(); setF({ ...f, amount: '', description: '', reference: '' }); setMsg({ ok: 'Transfer recorded.' }); await list.reload();
    } catch (err) { if (!ov.take(err)) setMsg({ error: errorText(err) }); }
  }
  async function reverse(t: Transfer) {
    setMsg({});
    try { await api(w.path(`/bank-transfers/${t.id}/reverse`), { body: { reason: revReason[t.id] ?? '', ...rev.body() }, idempotencyKey: crypto.randomUUID() }); rev.reset(); setMsg({ ok: 'Transfer reversed.' }); await list.reload(); }
    catch (err) { if (!rev.take(err)) setMsg({ error: errorText(err) }); }
  }
  const sel = (k: 'fromAccountId' | 'toAccountId', label: string) => (
    <div><label htmlFor={`t-${k}`}>{label}</label><select id={`t-${k}`} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} required><option value="">Choose…</option>{money.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></div>
  );
  return (
    <>
      <div className="card">
        <h1>Transfers</h1>
        <BankNav />
        {list.error && <p className="error" role="alert">{list.error}</p>}
        {list.data && (list.data.items.length === 0 ? <p className="muted">None recorded.</p> : (
          <table data-testid="transfers">
            <thead><tr><th>Date</th><th>From</th><th>To</th><th>Description</th><th className="num">Amount</th><th>Status</th><th /></tr></thead>
            <tbody>{list.data.items.map((t) => (
              <tr key={t.id}><td>{t.transferDate}</td><td>{name(t.fromAccountId)}</td><td>{name(t.toAccountId)}</td><td>{t.description}</td><td className="num">{t.amount} {t.currency}</td><td>{t.status}</td>
                <td>{t.status === 'POSTED' && w.can('bank:transfer') && <div className="inline-actions"><input aria-label={`Reason to reverse ${t.description}`} placeholder="Reason to reverse" value={revReason[t.id] ?? ''} onChange={(e) => setRevReason({ ...revReason, [t.id]: e.target.value })} />
                  <button className="secondary" onClick={() => reverse(t)}>Reverse</button></div>}</td></tr>
            ))}</tbody>
          </table>
        ))}
        {rev.view}
      </div>
      {w.can('bank:transfer') && (
        <div className="card" data-testid="record-transfer">
          <h2>Move money</h2>
          <form onSubmit={record}>
            <div className="row">{sel('fromAccountId', 'From')}{sel('toAccountId', 'To')}
              <div><label htmlFor="t-date">Date</label><input id="t-date" type="date" value={f.transferDate} onChange={(e) => setF({ ...f, transferDate: e.target.value })} required /></div>
              <div><label htmlFor="t-amount">Amount</label><input id="t-amount" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} required /></div>
              <div><label htmlFor="t-desc">Description</label><input id="t-desc" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} required /></div>
            </div>
            {ov.view}
            <button type="submit">Record transfer</button>
          </form>
        </div>
      )}
      {msg.ok && <p className="ok" role="status">{msg.ok}</p>}
      {msg.error && <p className="error" role="alert">{msg.error}</p>}
    </>
  );
}
