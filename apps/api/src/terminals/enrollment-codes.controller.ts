import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequireBranchId } from "../security/decorators/require-branch.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { IssueEnrollmentCodeDto, RedeemEnrollmentCodeDto } from "./dto/terminal-enrollment.dto";
import { EnrollmentCodesService } from "./enrollment-codes.service";

/** P2 one-time enrollment codes (contract: docs/API_CONTRACT.md "Desktop enrollment and staff
 * sessions"). Issuing, listing and revoking need branch management; redeeming needs only counter
 * access, because the code carries the manager's authorization for one counter. */
@ApiTags("terminals")
@UseGuards(ThrottlerGuard)
@Controller("terminals")
export class EnrollmentCodesController {
  constructor(private readonly codes: EnrollmentCodesService) {}

  @RequirePermission("tenant.management")
  @Get("enrollment-codes")
  list(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string) {
    return this.codes.list(user, branchId);
  }

  @RequirePermission("tenant.management")
  @Post("enrollment-codes")
  issue(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() dto: IssueEnrollmentCodeDto,
  ) {
    return this.codes.issue(user, branchId, { registerId: dto.registerId, expiresInMinutes: dto.expiresInMinutes });
  }

  @RequirePermission("tenant.management")
  @Post("enrollment-codes/:codeId/revoke")
  @HttpCode(200)
  revoke(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("codeId", ParseUUIDPipe) codeId: string,
  ) {
    return this.codes.revoke(user, branchId, codeId);
  }

  /** Guessing is bounded by the throttle, single use, expiry and the branch scope. */
  @RequirePermission("terminal.execute")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("enrollments/code-challenge")
  @HttpCode(200)
  redeem(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() dto: RedeemEnrollmentCodeDto,
  ) {
    return this.codes.redeemChallenge(user, branchId, {
      code: dto.code,
      keyId: dto.keyId,
      publicKeyHex: dto.publicKeyHex,
      label: dto.label,
    });
  }
}
