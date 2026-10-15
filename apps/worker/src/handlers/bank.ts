import { JobTypes } from '@uk/contracts';
import type { Database } from '@uk/db';
import { UnrecoverableError, type JobRuntime } from '@uk/jobs';
import { BankStatementService, type StatementStorage } from '@uk/platform';

/** M7a (DEC-040, ADR-61): stages a CSV bank statement. Never posts: the worker cannot reach the accounting package. */
export function registerBankImport(rt: JobRuntime, deps: { db: Database; storage: StatementStorage; captureDeviceMetadata?: boolean }): void {
  const service = new BankStatementService({ captureDeviceMetadata: deps.captureDeviceMetadata });
  rt.register(JobTypes.bankStatementImport, async ({ payload, organisationId, userId, progress }) => {
    if (!organisationId) throw new UnrecoverableError('bank.statement.import requires an organisation');
    return service.process(deps.db, deps.storage, { organisationId, userId: userId ?? undefined, importId: payload.importId, progress });
  });
}
