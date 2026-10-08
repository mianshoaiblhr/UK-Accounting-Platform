import { z, type ZodTypeAny } from 'zod';

/** Every workload class named in the V0 brief gets a queue now; later versions only add handlers. */
export const QUEUES = [
  'documents', 'imports', 'exports', 'ai', 'reconciliation',
  'notifications', 'reports', 'integrations', 'scheduled',
] as const;
export type QueueName = (typeof QUEUES)[number];
export const DEAD_LETTER_QUEUE = 'dead-letter';

export interface RetryPolicy {
  attempts: number;
  /** Base delay (ms) for exponential backoff: delay * 2^(attempt-1). */
  backoffMs: number;
}

export interface JobDefinition<S extends ZodTypeAny = ZodTypeAny> {
  type: string;
  queue: QueueName;
  schema: S;
  retry: RetryPolicy;
  /** Payload is AES-GCM encrypted at rest in Redis and job_record (tokens, personal data). */
  sensitive?: boolean;
}

export const defineJob = <S extends ZodTypeAny>(d: JobDefinition<S>): JobDefinition<S> => d;

export const JobTypes = {
  emailSend: defineJob({
    type: 'email.send', queue: 'notifications', sensitive: true,
    retry: { attempts: 5, backoffMs: 2_000 },
    schema: z.object({
      to: z.string().email(), subject: z.string().max(300), text: z.string().max(20_000),
      template: z.string().max(60).optional(),
    }),
  }),
  documentProcess: defineJob({
    type: 'document.process', queue: 'documents',
    retry: { attempts: 4, backoffMs: 5_000 },
    schema: z.object({ documentVersionId: z.string().uuid() }),
  }),
  systemEcho: defineJob({
    type: 'system.echo', queue: 'scheduled',
    retry: { attempts: 3, backoffMs: 100 },
    schema: z.object({ message: z.string(), failTimes: z.number().int().min(0).default(0), permanent: z.boolean().default(false) }),
  }),
} as const;

export const ALL_JOB_DEFINITIONS: JobDefinition[] = Object.values(JobTypes);

export const JOB_STATUSES = ['QUEUED', 'RUNNING', 'RETRYING', 'COMPLETED', 'FAILED', 'DEAD'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
