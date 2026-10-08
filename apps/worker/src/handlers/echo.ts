import { JobTypes } from '@uk/contracts';
import { UnrecoverableError, type JobRuntime } from '@uk/jobs';

/** Exercises retries/backoff/progress/DLQ. Safe: performs no side effects. */
export function registerEcho(rt: JobRuntime): void {
  rt.register(JobTypes.systemEcho, async ({ payload, attempt, progress }) => {
    await progress(25, 'started');
    if (payload.permanent) throw new UnrecoverableError('permanent failure requested');
    if (attempt <= payload.failTimes) throw new Error(`simulated failure on attempt ${attempt}`);
    await progress(90, 'finishing');
    return { echoed: payload.message, attempt };
  });
}
