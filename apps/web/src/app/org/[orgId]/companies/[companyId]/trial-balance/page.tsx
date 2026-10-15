'use client';
import Link from 'next/link';
import { useState } from 'react';
import { WorkspaceShell, qs, useApi, useWorkspace } from '@/lib/workspace';

interface TrialBalance {
  currency: string; asOf: string; period: { startDate: string; endDate: string; status: string } | null;
  rows: { accountId: string; code: string; name: string; debit: string; credit: string; drilldown: { accountId: string; from: string | null; to: string } }[];
  totalDebit: string; totalCredit: string; balanced: boolean; warnings: { code: string; accountCode: string; message: string; balance: string }[];
}

function TrialBalancePage() {
  const w = useWorkspace();
  const [asOf, setAsOf] = useState('');
  const { data, error } = useApi<TrialBalance>(w.path(`/reports/trial-balance${qs({ asOf })}`));
  return (
    <div className="card">
      <h1>Trial balance</h1>
      <div className="row"><div><label htmlFor="asOf">As at</label><input id="asOf" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></div></div>
      {error && <p className="error" role="alert">{error}</p>}
      {data && (
        <>
          <p className="muted">As at {data.asOf} in {data.currency}{data.period ? ` · period ${data.period.startDate} to ${data.period.endDate} (${data.period.status.toLowerCase()})` : ''}</p>
          {data.warnings.map((x, i) => <p key={i} className="error">{x.accountCode}: {x.message} ({x.balance})</p>)}
          <table data-testid="trial-balance">
            <thead><tr><th>Code</th><th>Account</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.accountId}>
                  <td><Link href={`${w.base}/ledger${qs({ accountId: r.accountId, from: r.drilldown.from ?? undefined, to: r.drilldown.to })}`}>{r.code}</Link></td>
                  <td>{r.name}</td><td className="num">{r.debit}</td><td className="num">{r.credit}</td>
                </tr>
              ))}
              <tr className="total"><td /><td>Total</td><td className="num">{data.totalDebit}</td><td className="num">{data.totalCredit}</td></tr>
            </tbody>
          </table>
          <p className={data.balanced ? 'ok' : 'error'} role="status">{data.balanced ? 'Balanced' : 'Not balanced'}</p>
        </>
      )}
    </div>
  );
}

export default function Page() { return <WorkspaceShell need="ledger:read"><TrialBalancePage /></WorkspaceShell>; }
