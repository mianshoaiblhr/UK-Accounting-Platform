'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { api, errorText } from '@/lib/api';
import { useApi, useWorkspace } from '@/lib/workspace';

export interface BankAccount { id: string; accountId: string; accountCode: string; accountName: string; name: string; bankName: string | null; currency: string; detailsMasked: string | null;
  statementOpeningDate: string; statementOpeningBalance: string; ledgerBalance: string; statement: { lines: number; balance: string; lastDate: string | null; unmatchedLines: number }; status: string }
interface Account { id: string; code: string; name: string; type: string; subtype: string; isControl: boolean }

export function BankNav() {
  const w = useWorkspace();
  const pathname = usePathname();
  const at = (href: string) => (pathname === href ? 'page' : undefined);
  return (
    <nav className="subnav" aria-label="Bank" data-testid="bank-nav">
      <Link href={`${w.base}/bank`} aria-current={at(`${w.base}/bank`)}>Bank accounts</Link>
      {w.can('cash:read') && <Link href={`${w.base}/cash`} aria-current={at(`${w.base}/cash`)}>Cash transactions</Link>}
      <Link href={`${w.base}/bank/transfers`} aria-current={at(`${w.base}/bank/transfers`)}>Transfers</Link>
    </nav>
  );
}

/** Bank accounts over the bank ledger accounts (M9c). Details are sent once; only the API's mask is shown. */
export function BankAccounts() {
  const w = useWorkspace();
  const { data, error, reload } = useApi<{ items: BankAccount[] }>(w.path('/bank-accounts'));
  const accounts = useApi<{ items: Account[] }>(w.can('bank:manage') ? w.path('/accounts') : null);
  const [f, setF] = useState({ accountId: '', name: '', bankName: '', statementOpeningDate: '', statementOpeningBalance: '0.00', sortCode: '', accountNumber: '', chargesAccountId: '' });
  const [msg, setMsg] = useState<{ ok?: string; error?: string }>({});
  const taken = new Set((data?.items ?? []).map((b) => b.accountId));
  const free = (accounts.data?.items ?? []).filter((a) => a.subtype === 'CURRENT_ASSET_BANK' && !taken.has(a.id));
  async function add(e: FormEvent) {
    e.preventDefault(); setMsg({});
    try {
      const details = f.sortCode || f.accountNumber ? { details: { ...(f.sortCode ? { sortCode: f.sortCode } : {}), ...(f.accountNumber ? { accountNumber: f.accountNumber } : {}) } } : {};
      await api(w.path('/bank-accounts'), { body: { accountId: f.accountId, name: f.name, ...(f.bankName ? { bankName: f.bankName } : {}), statementOpeningDate: f.statementOpeningDate, statementOpeningBalance: f.statementOpeningBalance, ...(f.chargesAccountId ? { chargesAccountId: f.chargesAccountId } : {}), ...details }, idempotencyKey: crypto.randomUUID() });
      setF({ ...f, accountId: '', name: '', bankName: '', sortCode: '', accountNumber: '' }); setMsg({ ok: 'Bank account added.' }); await reload();
    } catch (err) { setMsg({ error: errorText(err) }); }
  }
  const field = (k: keyof typeof f, label: string, o: { type?: string; required?: boolean } = {}) => (
    <div><label htmlFor={`ba-${k}`}>{label}</label><input id={`ba-${k}`} type={o.type ?? 'text'} value={f[k]} required={o.required} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></div>
  );
  return (
    <>
      <div className="card">
        <h1>Bank accounts</h1>
        <BankNav />
        {error && <p className="error" role="alert">{error}</p>}
        {data && (data.items.length === 0 ? <p className="muted">No bank accounts yet.</p> : (
          <table data-testid="bank-accounts">
            <thead><tr><th>Name</th><th>Ledger account</th><th>Details</th><th className="num">Ledger balance</th><th className="num">Statement balance</th><th className="num">Unmatched lines</th></tr></thead>
            <tbody>{data.items.map((b) => (
              <tr key={b.id}><td><Link href={`${w.base}/bank/${b.id}`}>{b.name}</Link>{b.bankName ? <span className="muted"> {b.bankName}</span> : null}{b.status !== 'ACTIVE' ? ` (${b.status.toLowerCase()})` : ''}</td>
                <td>{b.accountCode} {b.accountName}</td><td>{b.detailsMasked ?? ''}</td><td className="num">{b.ledgerBalance} {b.currency}</td><td className="num">{b.statement.balance}</td><td className="num">{b.statement.unmatchedLines}</td></tr>
            ))}</tbody>
          </table>
        ))}
      </div>
      {w.can('bank:manage') && (
        <div className="card" data-testid="new-bank-account">
          <h2>Add a bank account</h2>
          <form onSubmit={add}>
            <div className="row">
              <div><label htmlFor="ba-accountId">Ledger account</label>
                <select id="ba-accountId" value={f.accountId} required onChange={(e) => setF({ ...f, accountId: e.target.value })}>
                  <option value="">Choose…</option>{free.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
                </select></div>
              {field('name', 'Name', { required: true })}{field('bankName', 'Bank')}
            </div>
            <div className="row">
              {field('statementOpeningDate', 'Statement opening date', { type: 'date', required: true })}{field('statementOpeningBalance', 'Statement opening balance', { required: true })}
              {field('sortCode', 'Sort code (stored encrypted)')}{field('accountNumber', 'Account number (stored encrypted)')}
              <div><label htmlFor="ba-charges">Account for bank charges</label>
                <select id="ba-charges" value={f.chargesAccountId} onChange={(e) => setF({ ...f, chargesAccountId: e.target.value })}>
                  <option value="">None</option>{(accounts.data?.items ?? []).filter((a) => a.type === 'EXPENSE' && !a.isControl).map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
                </select></div>
            </div>
            <button type="submit">Add bank account</button>
          </form>
          {msg.ok && <p className="ok" role="status">{msg.ok}</p>}
          {msg.error && <p className="error" role="alert">{msg.error}</p>}
        </div>
      )}
    </>
  );
}
