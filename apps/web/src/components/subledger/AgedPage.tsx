'use client';
import Link from 'next/link';
import { useState } from 'react';
import { qs, useApi, useWorkspace } from '@/lib/workspace';
import { SideNav } from './SideNav';
import type { Side } from './side';

type Row = { notDue: string; days1to30: string; days31to60: string; days61to90: string; over90: string; total: string; currency: string; unallocatedCredits?: string; unallocatedDebits?: string };
type PartyRow = Row & { customerRoleId?: string; supplierRoleId?: string; accountCode: string | null; name: string | null };
const COLS: [keyof Row, string][] = [['notDue', 'Not due'], ['days1to30', '1-30'], ['days31to60', '31-60'], ['days61to90', '61-90'], ['over90', 'Over 90']];

export function AgedPage({ side }: { side: Side }) {
  const w = useWorkspace();
  const [asOf, setAsOf] = useState('');
  const { data, error } = useApi<{ asOf: string; customers?: PartyRow[]; suppliers?: PartyRow[]; totals: Row[] }>(w.path(`${side.aged.path}${qs({ asOf })}`));
  const rows = data?.[side.aged.rows] ?? [];
  return (
    <div className="card">
      <h1>{side.aged.label}</h1>
      <SideNav side={side} />
      <div className="row"><div><label htmlFor="asOf">As at</label><input id="asOf" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></div></div>
      {error && <p className="error" role="alert">{error}</p>}
      {data && (
        <table data-testid="aged">
          <thead><tr><th>{side.party}</th><th>Currency</th>{COLS.map(([, l]) => <th key={l} className="num">{l}</th>)}<th className="num">Unallocated</th><th className="num">Total</th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const id = r[side.partyField]!;
              return (
                <tr key={`${id}-${r.currency}`} data-party={id}>
                  <td><Link href={`${w.base}/${side.key}/parties/${id}`}>{r.name}{r.accountCode ? ` (${r.accountCode})` : ''}</Link></td><td>{r.currency}</td>
                  {COLS.map(([k]) => <td key={k} className="num">{r[k]}</td>)}<td className="num">{r[side.aged.unallocated]}</td><td className="num">{r.total}</td>
                </tr>
              );
            })}
            {data.totals.map((t) => (
              <tr key={t.currency} className="total"><td>Total</td><td>{t.currency}</td>{COLS.map(([k]) => <td key={k} className="num">{t[k]}</td>)}<td className="num">{t[side.aged.unallocated]}</td><td className="num" data-testid="aged-total">{t.total}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
