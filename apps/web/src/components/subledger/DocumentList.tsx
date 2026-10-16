'use client';
import Link from 'next/link';
import { useState } from 'react';
import { qs, useApi, useWorkspace } from '@/lib/workspace';
import { SideNav } from './SideNav';
import { partyName, type Party, type Side } from './side';

export interface DocHeader { id: string; kind: string; status: string; paymentStatus: string | null; documentNumber: string | null; supplierReference?: string | null; customerReference?: string | null;
  customerRoleId?: string; supplierRoleId?: string; issueDate: string; dueDate: string; currency: string; totals: { net: string; vat: string; gross: string }; outstanding: string }

export function DocumentList({ side }: { side: Side }) {
  const w = useWorkspace();
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const { data, error } = useApi<{ items: DocHeader[] }>(w.path(`${side.documents}${qs({ kind, status, limit: '200' })}`));
  const parties = useApi<{ items: Party[] }>(w.can('contact:read') ? w.path(`/contact-roles${qs({ role: side.role, status: 'ALL', limit: '100' })}`) : null);
  const name = (id?: string) => partyName(parties.data?.items.find((p) => p.id === id));
  return (
    <div className="card">
      <h1>{side.label}</h1>
      <SideNav side={side} />
      <div className="row">
        <div><label htmlFor="kind">Kind</label>
          <select id="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">All</option><option value={side.doc.kind}>{side.doc.label}s</option><option value={side.note.kind}>{side.note.label}s</option>
          </select></div>
        <div><label htmlFor="status">Status</label>
          <select id="status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option><option value="DRAFT">Draft</option><option value="APPROVED">Approved</option><option value="DISCARDED">Discarded</option>
          </select></div>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {data && (data.items.length === 0 ? <p className="muted">No documents.</p> : (
        <table data-testid="documents">
          <thead><tr><th>Number</th><th>Kind</th><th>{side.party}</th><th>Date</th><th>Status</th><th className="num">Gross</th><th className="num">Outstanding</th></tr></thead>
          <tbody>
            {data.items.map((d) => (
              <tr key={d.id} data-doc={d.id}>
                <td><Link href={`${w.base}/${side.key}/${d.id}`}>{d.documentNumber ?? 'draft'}{d.supplierReference ? ` · ${d.supplierReference}` : ''}</Link></td>
                <td>{d.kind === side.doc.kind ? side.doc.label : side.note.label}</td>
                <td>{name(d[side.partyField])}</td>
                <td>{d.issueDate}</td>
                <td>{d.status}{d.paymentStatus ? ` · ${d.paymentStatus}` : ''}</td>
                <td className="num">{d.totals.gross} {d.currency}</td>
                <td className="num">{d.status === 'APPROVED' ? d.outstanding : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </div>
  );
}
