'use client';
import Link from 'next/link';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { Product, SignOut } from '@/components/Nav';
import { ApiError, api, type Me } from '@/lib/api';

/**
 * The practice shell (V7-M2, DEC-089; prototype DEC-079): the sidebar of the client workspace, at the level of the organisation. It shows the
 * organisation and the practice sections; what each page may show is still decided by the API (a page without access says so).
 */
const SECTIONS: { href: string; label: string }[] = [
  { href: '/overview', label: 'Overview' },
  { href: '/clients', label: 'Clients' },
  { href: '/deadlines', label: 'Deadlines' },
  // V3-M4 (DEC-096)
  { href: '/taxonomy', label: 'Taxonomy mapping' },
];

export function PracticeShell({ children }: { children: (me: Me) => ReactNode }) {
  const { orgId } = useParams<{ orgId: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me>();
  useEffect(() => {
    api<Me>('/auth/me').then(setMe).catch((e) => { if (e instanceof ApiError && e.status === 401) router.push('/login'); });
  }, [router]);
  if (!me) return <main><p>Loading…</p></main>;
  const org = me.organisations.find((o) => o.id === orgId);
  const base = `/org/${orgId}`;
  return (
    <div className="shell">
      <aside>
        <Product />
        <div className="scope">
          <strong>{org?.name ?? 'Organisation'}</strong>
          {org && <span className="muted">{org.roleName}</span>}
          <span className="muted"><Link href="/">Change organisation</Link></span>
        </div>
        <nav className="sections" aria-label="Practice">
          <div className="group">Practice</div>
          {SECTIONS.map((s) => <Link key={s.href} href={`${base}${s.href}`} aria-current={pathname === `${base}${s.href}` ? 'page' : undefined}>{s.label}</Link>)}
        </nav>
        <div className="person">
          <span className="who" title={me.user.email}>{me.user.email}</span>
          <span className="links"><Link href="/security">Security</Link><SignOut /></span>
        </div>
      </aside>
      <main>{children(me)}</main>
    </div>
  );
}
