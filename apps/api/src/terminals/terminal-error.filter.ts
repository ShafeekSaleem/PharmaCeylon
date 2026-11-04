import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import {
  TERMINAL_CONTRACT_VERSION,
  terminalErrorRetryable,
  type TerminalApiError,
  type TerminalRouteErrorCode,
} from "@pharmaceylon/shared";

/** The code a refusal gets when it carries none of its own (a guard, a DTO, a plain message). */
const CODE_BY_STATUS: Readonly<Record<number, TerminalRouteErrorCode>> = {
  400: "BAD_REQUEST",
  401: "AUTHENTICATION_REQUIRED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  429: "RATE_LIMITED",
};

export function fallbackTerminalErrorCode(
  status: number,
): TerminalRouteErrorCode {
  if (status >= 500) return "SERVER_ERROR";
  return CODE_BY_STATUS[status] ?? "REQUEST_REFUSED";
}

export type TerminalErrorResponse = Readonly<{
  status: number;
  body: TerminalApiError & Readonly<Record<string, unknown>>;
}>;

/**
 * The shared `TerminalApiError` for any exception. A refusal keeps its `code`, `message` and any
 * fields of its own (`lockedUntil`); the contract fields are added. Anything that is not an
 * `HttpException` is a fault: 500 `SERVER_ERROR`, with its message kept out of the body.
 */
export function terminalErrorResponse(
  exception: unknown,
  correlationId: string,
): TerminalErrorResponse {
  const contract = (code: string, message: string) => ({
    contractVersion: TERMINAL_CONTRACT_VERSION,
    code,
    message,
    correlationId,
    retryable: terminalErrorRetryable(code),
  });
  if (!(exception instanceof HttpException))
    return {
      status: 500,
      body: {
        statusCode: 500,
        ...contract("SERVER_ERROR", "Internal server error"),
      },
    };
  const status = exception.getStatus();
  const raw = exception.getResponse();
  const fields: Record<string, unknown> =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const code =
    typeof fields.code === "string" && fields.code
      ? fields.code
      : fallbackTerminalErrorCode(status);
  // ValidationPipe sends a list; the contract carries one string.
  const listed = Array.isArray(fields.message)
    ? fields.message.filter((item): item is string => typeof item === "string")
    : [];
  const message =
    typeof raw === "string"
      ? raw
      : typeof fields.message === "string"
        ? fields.message
        : listed.length
          ? listed.join("; ")
          : exception.message;
  return {
    status,
    body: { ...fields, statusCode: status, ...contract(code, message) },
  };
}

/**
 * Sends every error from a terminal route (`/terminals/*`, `/terminal-commands/*`) as the shared
 * `TerminalApiError`, guard refusals included, and logs one line with the same `correlationId`.
 * The API has no request ID of its own, so the ID is minted per error. The line carries the
 * status, code and route pattern, never the message: messages can quote what a person typed.
 *
 * Errors raised before routing (malformed JSON, an unknown path) keep the platform body.
 */
@Catch()
export class TerminalErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger("TerminalErrors");

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const { status, body } = terminalErrorResponse(exception, randomUUID());
    const line = `terminal.error ${JSON.stringify({
      correlationId: body.correlationId,
      status,
      code: body.code,
      method: request.method,
      route:
        (request.route as { path?: unknown } | undefined)?.path ?? request.path,
    })}`;
    if (status >= 500)
      this.logger.error(
        line,
        exception instanceof Error ? exception.stack : undefined,
      );
    else this.logger.warn(line);
    if (response.headersSent) return;
    response.locals.correlationId = body.correlationId;
    response.status(status).json(body);
  }
}
