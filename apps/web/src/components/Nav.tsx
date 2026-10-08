'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, type Me } from '@/lib/api';

export function Nav({ me }: { me: Me }) {
  const router = useRouter();
  return (
    <nav>
      <div><strong>UK Accounting Platform</strong> <Link href="/">Dashboard</Link><Link href="/security">Security</Link></div>
      <div>
        <span className="muted">{me.user.email} </span>
        <button className="secondary" style={{ marginTop: 0 }} onClick={async () => { await api('/auth/logout', { method: 'POST' }); router.push('/login'); }}>Sign out</button>
      </div>
    </nav>
  );
}
