import { Catch, HttpException, Inject, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { AppError, getContext, type Logger } from '@uk/core';
import { LOGGER } from './tokens';

/** RFC 9457 problem+json for every error. Internal details never leak. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<{ originalUrl: string }>();
    let status = 500, code = 'internal_error', title = 'Internal server error', details: unknown;

    if (exception instanceof AppError) {
      status = exception.status; code = exception.code; title = exception.message; details = exception.details;
      if (status === 429) res.setHeader('Retry-After', String((exception.details as { retryAfterSeconds?: number })?.retryAfterSeconds ?? 60));
    } else if ((exception as { type?: string })?.type === 'entity.too.large') {
      status = 413; code = 'payload_too_large'; title = 'Payload too large';
    } else if ((exception as { type?: string })?.type === 'entity.parse.failed') {
      status = 400; code = 'invalid_json'; title = 'Malformed JSON body';
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = status === 404 ? 'not_found' : status === 413 ? 'payload_too_large'
        : status === 400 && /json/i.test(exception.message) ? 'invalid_json' : 'http_error';
      title = status === 404 ? 'Not found' : exception.message;
    } else {
      this.logger.error({ err: exception, path: req.originalUrl }, 'unhandled error');
    }
    res.status(status).type('application/problem+json').json({
      type: `urn:uk-platform:error:${code}`, title, status, code,
      ...(details !== undefined ? { errors: details } : {}),
      instance: req.originalUrl.split('?')[0],
      correlationId: getContext()?.correlationId,
    });
  }
}
