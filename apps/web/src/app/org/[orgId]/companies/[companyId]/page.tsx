'use client';
import Link from 'next/link';
import { useState } from 'react';
import { WorkspaceShell, qs, useApi, useWorkspace } from '@/lib/workspace';

interface Alert { code: string; severity: 'HIGH' | 'MEDIUM' | 'LOW'; title: string; count: number; total?: string; oldestDate?: string | null; items: Record<string, unknown>[] }
interface AlertList { asOf: string; count: number; high: number; alerts: Alert[] }

/** The three controls V1 asks the dashboard to show first (V1-CTL-03, V1-CTL-04, V1-BANK-05), each from the alert list as the API computed it. */
const KEY: { label: string; codes: string[]; module: string }[] = [
  { label: 'Suspense balance', codes: ['suspense_balance'], module: 'ledger:read' },
  { label: 'Cash or bank below zero', codes: ['negative_cash', 'overdrawn_bank'], module: 'ledger:read' },
  { label: 'Unmatched statement lines', codes: ['old_unmatched_bank_lines'], module: 'bank:read' },
];

function Dashboard() {
  const w = useWorkspace();
  const [asOf, setAsOf] = useState('');
  const { data, error } = useApi<AlertList>(w.path(`/alerts${qs({ asOf })}`));
  const link = (a: Alert, item: Record<string, unknown>) => {
    const d = item.drilldown as { accountId?: string; to?: string } | undefined;
    if (d?.accountId) return `${w.base}/ledger${qs({ accountId: d.accountId, to: d.to })}`;
    return null;
  };
  return (
    <>
      <div className="card">
        <h1>Dashboard</h1>
        <div className="row">
          <div><label htmlFor="asOf">As at</label><input id="asOf" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></div>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        {data && (
          <table data-testid="key-controls">
            <thead><tr><th>Control</th><th className="num">Items</th><th className="num">Total</th></tr></thead>
            <tbody>
              {KEY.map((k) => {
                const hits = data.alerts.filter((a) => k.codes.includes(a.code));
                return (
                  <tr key={k.label}>
                    <td>{k.label}</td>
                    {w.can(k.module) ? <td className="num">{hits.reduce((n, a) => n + a.count, 0)}</td> : <td className="num muted">not visible to you</td>}
                    <td className="num">{hits.map((a) => a.total).filter(Boolean).join(' / ')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {data && (
        <div className="card">
          <h2>Alerts as at {data.asOf} ({data.count}, {data.high} high)</h2>
          {data.alerts.length === 0 ? <p className="ok" role="status">Nothing needs attention.</p> : (
            <table data-testid="alerts">
              <thead><tr><th>Severity</th><th>Alert</th><th className="num">Count</th><th>Oldest</th><th>Items</th></tr></thead>
              <tbody>
                {data.alerts.map((a) => (
                  <tr key={a.code} data-code={a.code}>
                    <td><span className={`badge ${a.severity}`}>{a.severity}</span></td>
                    <td>{a.title}{a.total ? <span className="muted"> ({a.total})</span> : null}</td>
                    <td className="num">{a.count}</td>
                    <td>{a.oldestDate ?? ''}</td>
                    <td>
                      {a.items.slice(0, 5).map((it, i) => {
                        const href = link(a, it);
                        const text = String(it.accountCode ?? it.documentId ?? it.name ?? it.requestId ?? it.paymentId ?? it.supplierRoleId ?? it.taxRateId ?? '');
                        return <div key={i}>{href ? <Link href={href}>{text} {String(it.balance ?? '')}</Link> : <span>{text} {String(it.balance ?? it.gross ?? it.unmatched ?? '')}</span>}</div>;
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </>
  );
}

export default function Page() { return <WorkspaceShell need="ledger:read"><Dashboard /></WorkspaceShell>; }
