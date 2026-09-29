import {
  Catch,
  type ArgumentsHost,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  DomainError,
  DuplicateDirectoryRecordError,
  CONFLICT_ERROR_CODES,
  VALIDATION_ERROR_CODES,
  ValidationError,
  redactLogText,
} from '@sgr-registry/domain';
import { MissingConfigurationError } from '@sgr-registry/config';

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string;
  requestId?: string;
  field?: string;
  existing?: { id: string; label: string };
}

@Catch()
export class SafeExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(SafeExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest & { requestId?: string }>();
    const requestIdHeader = request.requestId ?? request.headers['x-request-id'];
    const requestId = typeof requestIdHeader === 'string' ? requestIdHeader : undefined;

    const body = this.toSafeBody(exception, requestId);
    const details =
      exception instanceof Error ? (exception.stack ?? exception.message) : String(exception);
    this.logger.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        service: 'api',
        level: 'error',
        event: 'http_exception',
        requestId: requestId ?? null,
        statusCode: body.statusCode,
        errorCode: body.error,
        detail: redactLogText(details).slice(0, 2_000),
      }),
    );

    void response.status(body.statusCode).send(body);
  }

  private toSafeBody(exception: unknown, requestId?: string): ErrorBody {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const message =
        typeof payload === 'string'
          ? payload
          : typeof payload === 'object' && payload !== null && 'message' in payload
            ? String((payload as { message: string | string[] }).message)
            : exception.message;
      return {
        statusCode: status,
        error: HttpStatus[status] ?? 'Error',
        message,
        requestId,
      };
    }

    if (exception instanceof DomainError) {
      const status =
        exception.code === 'FORBIDDEN_FIELD'
          ? HttpStatus.FORBIDDEN
          : exception.code === 'PAYLOAD_TOO_LARGE'
            ? HttpStatus.PAYLOAD_TOO_LARGE
            : CONFLICT_ERROR_CODES.has(exception.code)
              ? HttpStatus.CONFLICT
              : VALIDATION_ERROR_CODES.has(exception.code)
                ? HttpStatus.BAD_REQUEST
                : HttpStatus.UNPROCESSABLE_ENTITY;
      return {
        statusCode: status,
        error: exception.code,
        message: exception.message,
        requestId,
        ...(exception instanceof ValidationError ? { field: exception.field } : {}),
        ...(exception instanceof DuplicateDirectoryRecordError
          ? { existing: exception.existing }
          : {}),
      };
    }

    if (exception instanceof MissingConfigurationError) {
      return {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        error: 'CONFIGURATION_ERROR',
        message: 'Application configuration is incomplete',
        requestId,
      };
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error',
      requestId,
    };
  }
}
