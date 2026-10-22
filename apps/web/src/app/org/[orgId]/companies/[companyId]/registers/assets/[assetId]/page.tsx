'use client';
import { AssetScreen } from '@/components/registers/Asset';
import { WorkspaceShell } from '@/lib/workspace';

/** V2-M7b (DEC-074): behind `accounts.production`; the API enforces every route. */
export default function Page() { return <WorkspaceShell need="assets:read" feature="accounts.production"><AssetScreen /></WorkspaceShell>; }
