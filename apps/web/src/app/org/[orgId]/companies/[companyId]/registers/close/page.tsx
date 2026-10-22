'use client';
import { CloseScreen } from '@/components/registers/Close';
import { WorkspaceShell } from '@/lib/workspace';

/** V2-M7b (DEC-074): behind `accounts.production`; the API enforces every route. */
export default function Page() { return <WorkspaceShell need="ledger:read" feature="accounts.production"><CloseScreen /></WorkspaceShell>; }
