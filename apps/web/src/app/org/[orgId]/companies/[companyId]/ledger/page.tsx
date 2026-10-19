'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { WorkspaceShell, qs, useApi, useWorkspace } from '@/lib/workspace';

interface Ledger {
  currency: string; account: { id: string; code: string; name: string; type: string }; from: string | null; to: string | null; excludeClosing?: boolean; openingBalance: string;
  items: { journalId: string; journalNumber: number; journalDate: string; lineNo: number; description: string; sourceType: string; debit: string; credit: string; balance: string }[];
  nextCursor: string | null;
}

function LedgerPage() {
  const w = useWorkspace();
  const sp = useSearchParams();
  const accountId = sp.get('accountId') ?? '';
  const [from, setFrom] = useState(sp.get('from') ?? '');
  const [to, setTo] = useState(sp.get('to') ?? '');
  const [cursor, setCursor] = useState<string>();
  // a P&L drill-down leaves year-end closing journals out, as its figure does (DEC-060)
  const excludeClosing = sp.get('excludeClosing') === 'true' ? 'true' : undefined;
  const { data, error } = useApi<Ledger>(accountId ? w.path(`/ledger${qs({ accountId, from, to, cursor, limit: '200', excludeClosing })}`) : null);
  if (!accountId) return <div className="card"><p className="muted">Open an account from the chart of accounts or the trial balance.</p></div>;
  return (
    <div className="card">
      <h1>General ledger{data ? `: ${data.account.code} ${data.account.name}` : ''}</h1>
      <div className="row">
        <div><label htmlFor="from">From</label><input id="from" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setCursor(undefined); }} /></div>
        <div><label htmlFor="to">To</label><input id="to" type="date" value={to} onChange={(e) => { setTo(e.target.value); setCursor(undefined); }} /></div>
      </div>
      {data?.excludeClosing && <p className="muted" data-testid="excludes-closing">Year-end closing journals are left out, as in the profit and loss figure this came from.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {data && (
        <table data-testid="ledger">
          <thead><tr><th>Date</th><th>Journal</th><th>Description</th><th>Source</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance ({data.currency})</th></tr></thead>
          <tbody>
            <tr><td colSpan={6}>Opening balance</td><td className="num">{data.openingBalance}</td></tr>
            {data.items.map((l) => (
              <tr key={`${l.journalId}-${l.lineNo}`}>
                <td>{l.journalDate}</td>
                <td><Link href={`${w.base}/journals/${l.journalId}`}>{l.journalNumber}</Link></td>
                <td>{l.description}</td><td>{l.sourceType}</td>
                <td className="num">{l.debit}</td><td className="num">{l.credit}</td><td className="num">{l.balance}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data?.nextCursor && <button className="secondary" onClick={() => setCursor(data.nextCursor!)}>Next page</button>}
    </div>
  );
}

export default function Page() { return <WorkspaceShell need="ledger:read"><Suspense fallback={<p>Loading…</p>}><LedgerPage /></Suspense></WorkspaceShell>; }
