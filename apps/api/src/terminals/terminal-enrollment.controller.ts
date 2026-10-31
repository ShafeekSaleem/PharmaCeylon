import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../security/decorators/current-user.decorator";
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
import { StaffCredentialsService } from "./staff-credentials.service";
import { TerminalEnrollmentService } from "./terminal-enrollment.service";

const MANAGE = "tenant.management";
const COUNTER = "terminal.execute";

/** P2 desktop enrollment and staff sessions (contract: docs/API_CONTRACT.md "Desktop enrollment
 * and staff sessions"). Permissions here are route gates; `TerminalTrustService` rechecks live
 * authority, the server challenge, the device signature and a recorded local-attendance proof.
 * Signed bodies are typed `unknown` and parsed strictly by the terminal wire helpers.
 */
@ApiTags("terminals")
@Controller("terminals")
export class TerminalEnrollmentController {
  constructor(
    private readonly enrollment: TerminalEnrollmentService,
    private readonly credentials: StaffCredentialsService,
  ) {}

  @RequirePermission(MANAGE)
  @Get("counters")
  counters(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string) {
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

  @RequirePermission(MANAGE)
  @Post("enrollments")
  finishEnrollment(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() body: unknown,
  ) {
    return this.enrollment.finishEnrollment(user, branchId, body);
  }

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
    return this.enrollment.revokeEnrollment(user, branchId, enrollmentId, dto.reason);
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
    return this.enrollment.retireTerminal(user, branchId, terminalId, dto.reason);
  }

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

  @RequirePermission(COUNTER)
  @Post("sessions/:workSessionId/test-receipt")
  testReceipt(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("workSessionId", ParseUUIDPipe) workSessionId: string,
    @Body() dto: ConfirmTestReceiptDto,
  ) {
    return this.enrollment.recordTestReceipt(user, branchId, workSessionId, dto.printerName);
  }

  @RequirePermission(COUNTER)
  @Get("sessions/:workSessionId/credential")
  credential(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("workSessionId", ParseUUIDPipe) workSessionId: string,
  ) {
    return this.credentials.credential(user, branchId, workSessionId);
  }

  @RequirePermission(COUNTER)
  @Post("sessions/:workSessionId/pin")
  @HttpCode(200)
  setPin(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("workSessionId", ParseUUIDPipe) workSessionId: string,
    @Body() dto: SetCounterPinDto,
  ) {
    return this.credentials.setPin(user, branchId, workSessionId, { pin: dto.pin, password: dto.password });
  }

  @RequirePermission(COUNTER)
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
}
