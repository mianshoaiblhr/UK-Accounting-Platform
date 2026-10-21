'use client';
import { Suspense } from 'react';
import { ReviewScreen } from '@/components/yearend/Review';
import { WorkspaceShell } from '@/lib/workspace';

/** V2-M7a (DEC-071): behind `accounts.production`; the API enforces every route. */
export default function Page() { return <WorkspaceShell need="ledger:read" feature="accounts.production"><Suspense fallback={<p>Loading…</p>}><ReviewScreen /></Suspense></WorkspaceShell>; }
