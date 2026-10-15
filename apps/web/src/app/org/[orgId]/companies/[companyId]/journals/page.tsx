'use client';
import Link from 'next/link';
import { useState } from 'react';
import { WorkspaceShell, qs, useApi, useWorkspace } from '@/lib/workspace';

interface JournalHeader { id: string; journalNumber: number; journalDate: string; sourceType: string; sourceReference: string | null; description: string; total: string; reversedByJournalNumber: number | null; reversesJournalId: string | null }

function Journals() {
  const w = useWorkspace();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [source, setSource] = useState('');
  const [cursor, setCursor] = useState<string>();
  const { data, error } = useApi<{ currency: string; items: JournalHeader[]; nextCursor: string | null }>(w.path(`/journals${qs({ from, to, source, cursor, limit: '50' })}`));
  return (
    <div className="card">
      <h1>Journals</h1>
      <div className="row">
        <div><label htmlFor="from">From</label><input id="from" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setCursor(undefined); }} /></div>
        <div><label htmlFor="to">To</label><input id="to" type="date" value={to} onChange={(e) => { setTo(e.target.value); setCursor(undefined); }} /></div>
        <div><label htmlFor="source">Source</label><input id="source" placeholder="e.g. SALES_INVOICE" value={source} onChange={(e) => { setSource(e.target.value.toUpperCase()); setCursor(undefined); }} /></div>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {data && (data.items.length === 0 ? <p className="muted">No journals.</p> : (
        <table data-testid="journals">
          <thead><tr><th>No.</th><th>Date</th><th>Source</th><th>Description</th><th className="num">Total ({data.currency})</th></tr></thead>
          <tbody>
            {data.items.map((j) => (
              <tr key={j.id}>
                <td><Link href={`${w.base}/journals/${j.id}`}>{j.journalNumber}</Link></td>
                <td>{j.journalDate}</td>
                <td>{j.sourceType}{j.sourceReference ? <span className="muted"> {j.sourceReference}</span> : null}</td>
                <td>{j.description}{j.reversedByJournalNumber ? <span className="muted"> (reversed by {j.reversedByJournalNumber})</span> : null}</td>
                <td className="num">{j.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
      {data?.nextCursor && <button className="secondary" onClick={() => setCursor(data.nextCursor!)}>Next page</button>}
    </div>
  );
}

export default function Page() { return <WorkspaceShell need="ledger:read"><Journals /></WorkspaceShell>; }
