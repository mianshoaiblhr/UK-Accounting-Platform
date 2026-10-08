import { JobTypes } from '@uk/contracts';
import type { EmailPort } from '@uk/adapters';
import type { JobRuntime } from '@uk/jobs';

export function registerEmail(rt: JobRuntime, email: EmailPort): void {
  rt.register(JobTypes.emailSend, async ({ payload, log }) => {
    await email.send({ to: payload.to, subject: payload.subject, text: payload.text });
    log.info({ subject: payload.subject }, 'email sent'); // never log recipient body/token
    return { delivered: true };
  });
}
