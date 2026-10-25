'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, type Me } from '@/lib/api';

/** The product's mark (UI-1, DEC-076): the two sides of the ledger in balance, drawn as the double rule under a final total. */
export function Product() {
  return (
    <Link href="/" className="product">
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
        <rect width="22" height="22" rx="5" fill="var(--ink)" />
        <rect x="6" y="8.4" width="10" height="1.8" rx=".9" fill="var(--sheet)" />
        <rect x="6" y="11.8" width="10" height="1.8" rx=".9" fill="var(--sheet)" />
      </svg>
      UK Accounting Platform
    </Link>
  );
}

export function SignOut() {
  const router = useRouter();
  return <button className="secondary" onClick={async () => { await api('/auth/logout', { method: 'POST' }); router.push('/login'); }}>Sign out</button>;
}

/** The top bar on the pages outside a company (the company list, security). Inside a company the workspace's sidebar takes its place. */
export function Nav({ me }: { me: Me }) {
  return (
    <nav className="top" aria-label="Platform">
      <div className="links"><Product /><Link href="/">Companies</Link><Link href="/security">Security</Link></div>
      <div className="who">
        <span className="muted" title={me.user.email}>{me.user.email}</span>
        <SignOut />
      </div>
    </nav>
  );
}
