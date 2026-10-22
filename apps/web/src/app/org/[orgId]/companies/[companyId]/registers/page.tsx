'use client';
import { FixedAssetsScreen } from '@/components/registers/FixedAssets';
import { WorkspaceShell } from '@/lib/workspace';

/** V2-M7b (DEC-074): behind `accounts.production`; the API enforces every route. */
export default function Page() { return <WorkspaceShell need="assets:read" feature="accounts.production"><FixedAssetsScreen /></WorkspaceShell>; }
