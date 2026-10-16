'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { qs, useApi, useWorkspace } from '@/lib/workspace';
import { SideNav } from './SideNav';
import type { Side } from './side';

interface Statement { from: string; to: string; customer?: { name: string }; supplier?: { name: string };
  currencies: { currency: string; opening: string; closing: string; lines: { date: string; type: string; reference: string | null; documentNumber?: string | null; documentId: string; dueDate: string | null; debit: string; credit: string; balance: string }[] }[] }

export function StatementPage({ side }: { side: Side }) {
  const w = useWorkspace();
  const { roleId } = useParams<{ roleId: string }>();
  const year = new Date().getUTCFullYear();
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(`${year}-12-31`);
  const { data, error } = useApi<Statement>(from && to ? w.path(`${side.statement(roleId)}${qs({ from, to })}`) : null);
  const who = data?.customer ?? data?.supplier;
  return (
    <div className="card">
      <h1>Statement{who ? `: ${who.name}` : ''}</h1>
      <SideNav side={side} />
      <div className="row">
        <div><label htmlFor="from">From</label><input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div><label htmlFor="to">To</label><input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {data?.currencies.map((c) => (
        <table key={c.currency} data-testid="statement-lines">
          <thead><tr><th>Date</th><th>Type</th><th>Reference</th><th>Due</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance ({c.currency})</th></tr></thead>
          <tbody>
            <tr><td colSpan={6}>Opening balance</td><td className="num">{c.opening}</td></tr>
            {c.lines.map((l, i) => (
              <tr key={i}>
                <td>{l.date}</td><td>{l.type.replace(/_/g, ' ').toLowerCase()}</td>
                <td>{['INVOICE', 'CREDIT_NOTE', 'BILL', 'DEBIT_NOTE'].includes(l.type) ? <Link href={`${w.base}/${side.key}/${l.documentId}`}>{l.documentNumber ?? l.reference}</Link> : l.reference ?? ''}</td>
                <td>{l.dueDate ?? ''}</td><td className="num">{l.debit}</td><td className="num">{l.credit}</td><td className="num">{l.balance}</td>
              </tr>
            ))}
            <tr className="total"><td colSpan={6}>Closing balance</td><td className="num" data-testid="statement-closing">{c.closing}</td></tr>
          </tbody>
        </table>
      ))}
    </div>
  );
}
