'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api, errorText } from '@/lib/api';

function Inner() {
  const token = useSearchParams().get('token') ?? '';
  const [state, setState] = useState<'working' | 'ok' | string>('working');
  useEffect(() => {
    api('/auth/verify-email', { body: { token } }).then(() => setState('ok')).catch((e) => setState(errorText(e)));
  }, [token]);
  return (
    <main className="narrow card">
      <h1>Email verification</h1>
      {state === 'working' && <p>Verifying…</p>}
      {state === 'ok' && <p className="ok" role="status">Your email is verified. <Link href="/login">Sign in</Link></p>}
      {state !== 'working' && state !== 'ok' && <p className="error" role="alert">{state}</p>}
    </main>
  );
}
export default function Page() { return <Suspense><Inner /></Suspense>; }
