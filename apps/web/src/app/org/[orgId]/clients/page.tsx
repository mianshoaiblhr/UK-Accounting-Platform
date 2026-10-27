'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PracticeShell } from '@/components/PracticeShell';
import { KIND_NAMES } from '@/components/compliance/common';
import { ApiError, api, errorText } from '@/lib/api';
import { qs } from '@/lib/workspace';

/**
 * V7-M2 (DEC-089): the clients the person may read, with what the API says about each: year end, VAT, the next deadline, open and overdue
 * deadlines and the client manager. Search and filters are sent to the API; the page sorts and counts nothing itself.
 */
interface Client {
  id: string; name: string; companyNumber: string | null; legalForm: string; yearEnd: { month: number; day: number } | null;
  vat: { registered: boolean; periodMonths: number | null }; nextDeadline: { id: string; kind: string; title: string | null; dueDate: string; status: string; overdue: boolean } | null;
  openCount: number; overdueCount: number; clientManager: { userId: string; displayName: string | null } | null;
}
const FORMS: Record<string, string> = { LTD: 'Private limited company', LLP: 'Limited liability partnership', SOLE_TRADER: 'Sole trader', PARTNERSHIP: 'Partnership', CHARITY: 'Charity', OTHER: 'Other' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function Clients() {
  const { orgId } = useParams<{ orgId: string }>();
  const [q, setQ] = useState('');
  const [legalForm, setLegalForm] = useState('');
  const [mine, setMine] = useState(false);
  const [data, setData] = useState<{ items: Client[]; nextCursor: string | null }>();
  const [error, setError] = useState<{ text: string; off: boolean }>();
  // only the latest request may set the list: a slower answer for an earlier search is dropped
  const latest = useRef(0);
  const load = useCallback(async (cursor?: string) => {
    const call = ++latest.current;
    setError(undefined);
    try {
      const page = await api<{ items: Client[]; nextCursor: string | null }>(`/organisations/${orgId}/compliance/clients${qs({ q: q.trim() || undefined, legalForm: legalForm || undefined, manager: mine ? 'me' : undefined, cursor, limit: '50' })}`);
      if (call !== latest.current) return;
      setData((d) => cursor && d ? { items: [...d.items, ...page.items], nextCursor: page.nextCursor } : page);
    } catch (e) { if (call === latest.current) setError({ text: errorText(e), off: e instanceof ApiError && e.code === 'feature_disabled' }); }
  }, [orgId, q, legalForm, mine]);
  useEffect(() => { void load(); }, [load]);

  return (
    <>
      <h1>Clients</h1>
      {error && (error.off ? (
        <div className="card" role="status" data-testid="feature-off">
          <h2>Practice management is not enabled</h2>
          <p>These screens are not enabled for this organisation yet. An owner can turn on the &quot;practice.management&quot; feature.</p>
        </div>
      ) : <p className="error" role="alert">{error.text}</p>)}
      <div className="card">
        <div className="row">
          <div><label htmlFor="clientSearch">Find a client</label><input id="clientSearch" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name" /></div>
          <div><label htmlFor="clientForm">Type</label>
            <select id="clientForm" value={legalForm} onChange={(e) => setLegalForm(e.target.value)}><option value="">All types</option>{Object.entries(FORMS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
          <div><label htmlFor="clientMine" style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input id="clientMine" type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only clients I manage</label></div>
        </div>
        {data && (data.items.length === 0 ? <p className="muted">No clients match.</p> : (
          <table data-testid="clients">
            <thead><tr><th>Client</th><th>Year end</th><th>VAT</th><th>Next deadline</th><th className="num">Open</th><th className="num">Overdue</th><th>Manager</th></tr></thead>
            <tbody>{data.items.map((c) => (
              <tr key={c.id} data-client={c.id}>
                <td><Link href={`/org/${orgId}/companies/${c.id}`}>{c.name}</Link><div className="muted">{FORMS[c.legalForm] ?? c.legalForm}{c.companyNumber ? `, ${c.companyNumber}` : ''}</div></td>
                <td>{c.yearEnd ? `${c.yearEnd.day} ${MONTHS[c.yearEnd.month - 1]}` : <span className="muted">Not set</span>}</td>
                <td>{c.vat.registered ? (c.vat.periodMonths === 1 ? 'Monthly' : 'Quarterly') : <span className="muted">Not registered</span>}</td>
                <td>{c.nextDeadline ? <><Link href={`/org/${orgId}/companies/${c.id}/compliance`}>{c.nextDeadline.title ?? KIND_NAMES[c.nextDeadline.kind]}</Link><div className="muted">{c.nextDeadline.dueDate}{c.nextDeadline.overdue && <> <span className="badge HIGH">Overdue</span></>}</div></> : <span className="muted">None open</span>}</td>
                <td className="num">{c.openCount}</td>
                <td className="num">{c.overdueCount}</td>
                <td>{c.clientManager?.displayName ?? <span className="muted">Not set</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        ))}
        {data?.nextCursor && <button className="secondary" onClick={() => load(data.nextCursor!)}>Show more</button>}
      </div>
    </>
  );
}

export default function Page() { return <PracticeShell>{() => <Clients />}</PracticeShell>; }
