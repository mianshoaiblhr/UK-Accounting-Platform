'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Form } from '@/components/Form';
import { ReturnStatus, type ReturnSummary, type VatReturn } from '@/components/vat/common';
import { api } from '@/lib/api';
import { WorkspaceShell, useApi, useWorkspace } from '@/lib/workspace';

/** V5-M3 (DEC-092): the client's VAT returns, latest period first, as the API lists them. The period of a new return comes from the VAT settings (API). */
function Returns() {
  const w = useWorkspace();
  const router = useRouter();
  const list = useApi<{ items: ReturnSummary[] }>(w.path('/vat-returns'));
  const [date, setDate] = useState('');
  return (
    <>
      <div className="card">
        <h1>VAT returns</h1>
        <p className="muted">Each return is the VAT period&apos;s figures from the ledger, prepared, reviewed and approved by the client here. Nothing is sent to HMRC from the platform: a return is filed elsewhere and the filing is recorded here.</p>
        {list.error && <p className="error" role="alert">{list.error}</p>}
        {list.data && (list.data.items.length === 0 ? <p className="muted">No VAT returns yet.</p> : (
          <table data-testid="vat-returns">
            <thead><tr><th>Period</th><th>Status</th><th>Flags to explain</th></tr></thead>
            <tbody>{list.data.items.map((r) => (
              <tr key={r.id}>
                <td><Link href={`${w.base}/vat-returns/${r.id}`}>{r.periodFrom} to {r.periodTo}</Link></td>
                <td><ReturnStatus status={r.status} />{r.locked && <span className="muted"> period locked</span>}</td>
                <td className="num">{r.unexplainedFlags}</td>
              </tr>
            ))}</tbody>
          </table>
        ))}
      </div>
      {w.can('vat:prepare') && (
        <div className="card">
          <h2>Open the return for a period</h2>
          <p className="muted">Give any day of the VAT period; the period comes from the client&apos;s VAT settings.</p>
          <Form submit="Open the return" onSubmit={async () => {
            const r = await api<VatReturn>(w.path('/vat-returns'), { body: { date }, idempotencyKey: crypto.randomUUID() });
            router.push(`${w.base}/vat-returns/${r.id}`);
          }}>
            <label htmlFor="vatDate">A day in the period</label>
            <input id="vatDate" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
          </Form>
        </div>
      )}
    </>
  );
}

export default function Page() { return <WorkspaceShell need="ledger:read" feature="vat.returns"><Returns /></WorkspaceShell>; }
