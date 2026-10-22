'use client';
import { DepreciationScreen } from '@/components/registers/Depreciation';
import { WorkspaceShell } from '@/lib/workspace';

/** V2-M7b (DEC-074): behind `accounts.production`; the API enforces every route. */
export default function Page() { return <WorkspaceShell need="assets:read" feature="accounts.production"><DepreciationScreen /></WorkspaceShell>; }
