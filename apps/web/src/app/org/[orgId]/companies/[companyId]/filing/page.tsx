'use client';
import { Suspense } from 'react';
import { FilingScreen } from '@/components/filing/Filing';
import { WorkspaceShell } from '@/lib/workspace';

/** V3-M4 (DEC-096): behind `ixbrl.filing`; the API enforces every route. */
export default function Page() { return <WorkspaceShell need="ledger:read" feature="ixbrl.filing"><Suspense fallback={<p>Loading…</p>}><FilingScreen /></Suspense></WorkspaceShell>; }
