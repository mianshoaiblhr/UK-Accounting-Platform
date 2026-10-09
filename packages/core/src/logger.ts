import pino, { type Logger } from 'pino';
import { getContext } from './context';

export const REDACT_PATHS = [
  'password', '*.password', 'newPassword', '*.newPassword', 'currentPassword', '*.currentPassword',
  'token', '*.token', 'code', '*.code', 'secret', '*.secret', 'authorization', 'cookie',
  'req.headers.authorization', 'req.headers.cookie', 'headers.authorization', 'headers.cookie',
  'recoveryCodes', '*.recoveryCodes', 'passwordHash', '*.passwordHash',
];

export const createLogger = (level = 'info', name = 'uk-platform'): Logger =>
  pino({
    level,
    name,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    mixin() {
      const c = getContext();
      return c ? { correlationId: c.correlationId, traceId: c.traceId, userId: c.userId, organisationId: c.organisationId } : {};
    },
  });

export type { Logger };
