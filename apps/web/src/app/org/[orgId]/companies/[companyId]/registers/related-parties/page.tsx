'use client';
import { RelatedPartiesScreen } from '@/components/registers/Directors';
import { WorkspaceShell } from '@/lib/workspace';

/** V2-M7b (DEC-074): behind `accounts.production`; the API enforces every route. */
export default function Page() { return <WorkspaceShell need="ledger:read" feature="accounts.production"><RelatedPartiesScreen /></WorkspaceShell>; }
