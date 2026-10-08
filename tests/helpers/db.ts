import { execFileSync } from 'node:child_process';
import { Database } from '@uk/db';

/** Superuser-side SQL for arranging fixtures/asserting (bypasses RLS on purpose). */
export const adminSql = (sql: string) =>
  execFileSync('psql', ['postgresql://postgres@localhost:5432/uk_test', '-v', 'ON_ERROR_STOP=1', '-tAc', sql], { encoding: 'utf8' }).trim();

export const appDb = () => new Database(process.env.DATABASE_URL!);
