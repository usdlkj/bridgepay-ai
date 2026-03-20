import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { APIError } from 'openai';

/**
 * Maps upstream LLM HTTP errors to JSON responses instead of Nest's generic 500.
 * Uses 502 so clients don't confuse OpenAI 401 with JWT auth on this service.
 */
function sanitizeMessage(msg: string): string {
  // OpenAI error text can include a partial key or masked key (sk-…)
  return msg.replace(/\bsk-[a-zA-Z0-9_*-]{8,}/g, 'sk-…[redacted]');
}

@Catch(APIError)
export class LlmProviderApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(LlmProviderApiExceptionFilter.name);

  catch(exception: APIError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const upstream = exception.status;

    const message = sanitizeMessage(
      exception.message || 'LLM provider request failed',
    );

    this.logger.warn(
      `LLM provider API error status=${upstream ?? 'unknown'} code=${exception.code ?? 'n/a'}: ${message}`,
    );

    res.status(HttpStatus.BAD_GATEWAY).json({
      statusCode: HttpStatus.BAD_GATEWAY,
      message,
      error: 'Bad Gateway',
      providerStatus: upstream ?? undefined,
      providerCode: exception.code ?? undefined,
    });
  }
}
