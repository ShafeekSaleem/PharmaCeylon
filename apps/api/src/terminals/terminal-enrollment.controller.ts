import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import type { Request } from "express";
import { CounterRoute } from "../security/decorators/counter-route.decorator";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { Public } from "../security/decorators/public.decorator";
import { RequireBranchId } from "../security/decorators/require-branch.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import {
  BeginTerminalEnrollmentDto,
  ConfirmTestReceiptDto,
  CreateTerminalCounterDto,
  PrepareCounterPinDto,
  SetCounterPinDto,
  TerminalReasonDto,
} from "./dto/terminal-enrollment.dto";
import { PinSignInService } from "./pin-sign-in.service";
import { StaffCredentialsService } from "./staff-credentials.service";
import { TerminalEnrollmentService } from "./terminal-enrollment.service";

const MANAGE = "tenant.management";
const COUNTER = "terminal.execute";

/** P2 desktop enrollment and staff sessions (contract: docs/API_CONTRACT.md "Desktop enrollment
 * and staff sessions"). `@CounterRoute()` marks what a PIN-opened counter login may call. Permissions here are route gates; `TerminalTrustService` rechecks live
 * authority, the server challenge, the device signature and a recorded local-attendance proof.
 * Signed bodies are typed `unknown` and parsed strictly by the terminal wire helpers.
 */
@ApiTags("terminals")
@Controller("terminals")
export class TerminalEnrollmentController {
  constructor(
    private readonly enrollment: TerminalEnrollmentService,
    private readonly credentials: StaffCredentialsService,
    private readonly pinSignIn: PinSignInService,
  ) {}

  @RequirePermission(MANAGE)
  @Get("counters")
  counters(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
  ) {
    return this.enrollment.listCounters(user, branchId);
  }

  @RequirePermission(MANAGE)
  @Post("counters")
  createCounter(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() dto: CreateTerminalCounterDto,
  ) {
    return this.enrollment.createCounter(user, branchId, dto.label);
  }

  @RequirePermission(MANAGE)
  @Post("enrollments/challenge")
  @HttpCode(200)
  beginEnrollment(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() dto: BeginTerminalEnrollmentDto,
  ) {
    return this.enrollment.beginEnrollment(user, branchId, {
      registerId: dto.registerId,
      keyId: dto.keyId,
      publicKeyHex: dto.publicKeyHex,
      label: dto.label,
    });
  }

  // The finish step is shared by both flows: a manager's direct enrollment and a staff member
  // redeeming a code. The service requires tenant.management unless the challenge carries a code.
  @RequirePermission(COUNTER)
  @Post("enrollments")
  finishEnrollment(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() body: unknown,
  ) {
    return this.enrollment.finishEnrollment(user, branchId, body);
  }

  @CounterRoute()
  @RequirePermission(COUNTER)
  @Get("enrollments/:enrollmentId")
  enrollmentStatus(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("enrollmentId", ParseUUIDPipe) enrollmentId: string,
  ) {
    return this.enrollment.enrollmentStatus(user, branchId, enrollmentId);
  }

  @RequirePermission(MANAGE)
  @Post("enrollments/:enrollmentId/revoke")
  @HttpCode(204)
  revokeEnrollment(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("enrollmentId", ParseUUIDPipe) enrollmentId: string,
    @Body() dto: TerminalReasonDto,
  ) {
    return this.enrollment.revokeEnrollment(
      user,
      branchId,
      enrollmentId,
      dto.reason,
    );
  }

  @RequirePermission(MANAGE)
  @Post("devices/:terminalId/retire")
  @HttpCode(204)
  retireTerminal(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("terminalId", ParseUUIDPipe) terminalId: string,
    @Body() dto: TerminalReasonDto,
  ) {
    return this.enrollment.retireTerminal(
      user,
      branchId,
      terminalId,
      dto.reason,
    );
  }

  @CounterRoute()
  @RequirePermission(COUNTER)
  @Post("attendance-proofs")
  recordAttendance(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() body: unknown,
  ) {
    return this.enrollment.recordAttendance(user, branchId, body);
  }

  @RequirePermission(COUNTER)
  @Post("sessions/challenge")
  @HttpCode(200)
  beginSession(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() body: unknown,
  ) {
    return this.enrollment.beginSession(user, branchId, body);
  }

  @RequirePermission(COUNTER)
  @Post("sessions")
  finishSession(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() body: unknown,
  ) {
    return this.enrollment.finishSession(user, branchId, body);
  }

  @CounterRoute()
  @RequirePermission(COUNTER)
  @Post("sessions/:workSessionId/end")
  @HttpCode(204)
  endSession(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("workSessionId", ParseUUIDPipe) workSessionId: string,
  ) {
    return this.enrollment.endSession(user, branchId, workSessionId);
  }

  @CounterRoute()
  @RequirePermission(COUNTER)
  @Post("sessions/:workSessionId/test-receipt")
  testReceipt(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("workSessionId", ParseUUIDPipe) workSessionId: string,
    @Body() dto: ConfirmTestReceiptDto,
  ) {
    return this.enrollment.recordTestReceipt(
      user,
      branchId,
      workSessionId,
      dto.printerName,
    );
  }

  @CounterRoute()
  @RequirePermission(COUNTER)
  @Get("sessions/:workSessionId/credential")
  credential(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("workSessionId", ParseUUIDPipe) workSessionId: string,
  ) {
    return this.credentials.credential(user, branchId, workSessionId);
  }

  // Both check a secret; the per-account lockouts are the real limit, this caps the rate.
  @CounterRoute()
  @RequirePermission(COUNTER)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("sessions/:workSessionId/pin")
  @HttpCode(200)
  setPin(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("workSessionId", ParseUUIDPipe) workSessionId: string,
    @Body() dto: SetCounterPinDto,
  ) {
    return this.credentials.setPin(user, branchId, workSessionId, {
      pin: dto.pin,
      password: dto.password,
    });
  }

  @CounterRoute()
  @RequirePermission(COUNTER)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("sessions/:workSessionId/prepare")
  @HttpCode(200)
  prepare(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("workSessionId", ParseUUIDPipe) workSessionId: string,
    @Body() dto: PrepareCounterPinDto,
  ) {
    return this.credentials.prepare(user, branchId, workSessionId, dto.pin);
  }

  // D-W5 PIN sign-in. Public: nobody is signed in. The enrolled device key, a console attendance
  // proof and the person's PIN (with its lockout) are the checks; the throttle caps the rate.
  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post("pin-sessions/challenge")
  @HttpCode(200)
  beginPinSession(@Body() body: unknown) {
    return this.pinSignIn.begin(body);
  }

  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post("pin-sessions")
  @HttpCode(200)
  finishPinSession(@Body() body: unknown, @Req() req: Request) {
    const ua = req.headers["user-agent"];
    return this.pinSignIn.finish(body, {
      userAgent: typeof ua === "string" ? ua : null,
      ipAddress: req.ip ?? null,
    });
  }
}
