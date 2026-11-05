import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { EXCEPTION_FILTERS_METADATA } from "@nestjs/common/constants";
import { ThrottlerException } from "@nestjs/throttler";
import { TERMINAL_ERROR_RETRYABLE } from "@pharmaceylon/shared";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TerminalCommandsController } from "../terminal-commands/terminal-commands.controller";
import { CounterWorkController } from "../terminal-commands/counter-work.controller";
import { EnrollmentCodesController } from "./enrollment-codes.controller";
import { OfflineActivationController } from "./offline-activation.controller";
import { OfflineAssignmentController } from "./offline-assignment.controller";
import { OfflineAuthorityController } from "./offline-authority.controller";
import { OFFLINE_ASSIGNMENT_ERRORS } from "./offline-assignment.service";
import { TerminalEnrollmentController } from "./terminal-enrollment.controller";
import {
  TerminalErrorFilter,
  terminalErrorResponse,
} from "./terminal-error.filter";
import { denied, invalid } from "./terminal-wire";

const ID = "6f1c1f43-2f0e-4b8e-9d55-0d8f0f8c1a10";
const shape = (fn: () => never) => {
  try {
    fn();
  } catch (error) {
    return terminalErrorResponse(error, ID);
  }
  throw new Error("expected a throw");
};

describe("terminal error body (TerminalApiError)", () => {
  it("adds the contract fields to a terminal refusal and keeps its code and message", () => {
    expect(shape(() => denied("CHALLENGE_EXPIRED"))).toEqual({
      status: 403,
      body: {
        statusCode: 403,
        contractVersion: 1,
        code: "CHALLENGE_EXPIRED",
        message: "Terminal authorization failed",
        correlationId: ID,
        retryable: false,
      },
    });
    expect(shape(invalid).body).toMatchObject({
      code: "INVALID_COMMAND",
      message: "Invalid terminal command",
      retryable: false,
    });
  });

  it("keeps a refusal's own fields, such as when a PIN lock ends", () => {
    const lockedUntil = "2026-11-04T10:15:00.000Z";
    const { body } = terminalErrorResponse(
      new ForbiddenException({
        code: "PIN_LOCKED",
        message: "Locked",
        lockedUntil,
      }),
      ID,
    );
    expect(body).toMatchObject({
      code: "PIN_LOCKED",
      lockedUntil,
      retryable: false,
    });
  });

  it("marks only the undecided failures retryable", () => {
    expect(
      terminalErrorResponse(
        new ForbiddenException({
          code: "TEMPORARILY_UNAVAILABLE",
          message: "Hours unset",
        }),
        ID,
      ).body.retryable,
    ).toBe(true);
    expect(terminalErrorResponse(new ThrottlerException(), ID)).toMatchObject({
      status: 429,
      body: { code: "RATE_LIMITED", retryable: true },
    });
    expect(
      terminalErrorResponse(new ServiceUnavailableException(), ID),
    ).toMatchObject({
      status: 503,
      body: { code: "SERVER_ERROR", retryable: true },
    });
  });

  it("passes a domain core's own code through, never retryable", () => {
    const { body } = terminalErrorResponse(
      new ConflictException({ code: "COST_CONFLICT", message: "Pick a cost" }),
      ID,
    );
    expect(body).toMatchObject({
      code: "COST_CONFLICT",
      message: "Pick a cost",
      retryable: false,
    });
  });

  it("gives an uncoded refusal a code by status and keeps its message", () => {
    const cases: Array<[HttpException, number, string, string]> = [
      [
        new BadRequestException("Give a reason for this assignment."),
        400,
        "BAD_REQUEST",
        "Give a reason for this assignment.",
      ],
      [
        new UnauthorizedException("Invalid access token"),
        401,
        "AUTHENTICATION_REQUIRED",
        "Invalid access token",
      ],
      [
        new ForbiddenException("No access to requested branch"),
        403,
        "FORBIDDEN",
        "No access to requested branch",
      ],
      [
        new HttpException("Counter not found.", 404),
        404,
        "NOT_FOUND",
        "Counter not found.",
      ],
      [new ConflictException("Already used"), 409, "CONFLICT", "Already used"],
      [
        new HttpException("Too large", 413),
        413,
        "REQUEST_REFUSED",
        "Too large",
      ],
    ];
    for (const [exception, status, code, message] of cases)
      expect(terminalErrorResponse(exception, ID)).toMatchObject({
        status,
        body: {
          statusCode: status,
          contractVersion: 1,
          code,
          message,
          correlationId: ID,
        },
      });
  });

  it("carries a DTO's list of problems as one message", () => {
    const { body } = terminalErrorResponse(
      new BadRequestException([
        "reason must be a string",
        "reason should not be empty",
      ]),
      ID,
    );
    expect(body).toMatchObject({
      code: "BAD_REQUEST",
      message: "reason must be a string; reason should not be empty",
    });
  });

  it("answers a fault 500 SERVER_ERROR without its message", () => {
    expect(
      terminalErrorResponse(
        new Error('relation "terminal" does not exist'),
        ID,
      ),
    ).toEqual({
      status: 500,
      body: {
        statusCode: 500,
        contractVersion: 1,
        code: "SERVER_ERROR",
        message: "Internal server error",
        correlationId: ID,
        retryable: true,
      },
    });
  });
});

describe("terminal error filter coverage", () => {
  it("is on every controller in the terminal modules", () => {
    const controllers = [
      EnrollmentCodesController,
      OfflineActivationController,
      OfflineAssignmentController,
      OfflineAuthorityController,
      TerminalEnrollmentController,
      TerminalCommandsController,
      CounterWorkController,
    ];
    for (const controller of controllers)
      expect(
        Reflect.getMetadata(EXCEPTION_FILTERS_METADATA, controller),
      ).toEqual([TerminalErrorFilter]);
    // A new controller file in either module must be added above.
    const files = ["terminals", "terminal-commands"].flatMap((dir) =>
      readdirSync(join(__dirname, "..", dir)).filter((name) =>
        name.endsWith(".controller.ts"),
      ),
    );
    expect(files.sort()).toEqual([
      "counter-work.controller.ts",
      "enrollment-codes.controller.ts",
      "offline-activation.controller.ts",
      "offline-assignment.controller.ts",
      "offline-authority.controller.ts",
      "terminal-commands.controller.ts",
      "terminal-enrollment.controller.ts",
    ]);
  });

  it("has a retryable row for every code the terminal modules and auth guard send", () => {
    const sources = [
      ...["terminals", "terminal-commands"].flatMap((dir) =>
        readdirSync(join(__dirname, "..", dir))
          .filter((name) => name.endsWith(".ts") && !name.endsWith(".spec.ts"))
          .map((name) => join(__dirname, "..", dir, name)),
      ),
      join(__dirname, "..", "security", "guards", "jwt-auth.guard.ts"),
    ];
    const codes = new Set<string>(Object.values(OFFLINE_ASSIGNMENT_ERRORS));
    for (const file of sources) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/\bcode:\s*"([A-Z0-9_]+)"/g))
        codes.add(match[1]);
      for (const match of source.matchAll(/\bdenied\(\s*"([A-Z0-9_]+)"/g))
        codes.add(match[1]);
    }
    expect(codes.size).toBeGreaterThan(30);
    expect(
      [...codes].filter((code) => !(code in TERMINAL_ERROR_RETRYABLE)),
    ).toEqual([]);
  });
});
