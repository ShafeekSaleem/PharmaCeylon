import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../security/decorators/current-user.decorator";
import { RequireBranchId } from "../../security/decorators/require-branch.decorator";
import { RequirePermission } from "../../security/decorators/require-permission.decorator";
import type { RequestUser } from "../../security/interfaces/authenticated-request.interface";
import { OFFLINE_ASSIGNMENT_MANAGER_PERMISSION } from "../offline-assignment.service";
import {
  ApproveJournalRecoveryDto,
  MissingJournalSignOffDto,
} from "./journal-recovery.dto";
import { OfflineJournalRecoveryService } from "./journal-recovery.service";

/**
 * P5 #51, D11 (decisions of 2026-11-10), remote management: review and approve a restored
 * counter's journal recovery, and sign off the offline counter's journal so another counter can
 * take over. `tenant.management` is the route gate; approving and signing off additionally need
 * revised D13 authority (an owner, or a manager with the owner's live delegation for the
 * branch). Nothing here changes a counter or issues authority.
 */
@ApiTags("offline-journal-recoveries")
@Controller("offline-journal-recoveries")
export class OfflineJournalRecoveriesController {
  constructor(private readonly recovery: OfflineJournalRecoveryService) {}

  @ApiOperation({
    summary:
      "Journal recoveries at this branch and its offline counter's replacement readiness",
  })
  @RequirePermission(OFFLINE_ASSIGNMENT_MANAGER_PERMISSION)
  @Get()
  list(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string) {
    return this.recovery.list(user, branchId);
  }

  @ApiOperation({ summary: "One journal recovery with its evidence" })
  @RequirePermission(OFFLINE_ASSIGNMENT_MANAGER_PERMISSION)
  @Get(":id")
  detail(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.recovery.detail(user, branchId, id);
  }

  @ApiOperation({
    summary:
      "Approve a restored counter's journal recovery exactly as reported",
  })
  @RequirePermission(OFFLINE_ASSIGNMENT_MANAGER_PERMISSION)
  @Post(":id/approve")
  @HttpCode(200)
  approve(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ApproveJournalRecoveryDto,
  ) {
    return this.recovery.approve(user, branchId, id, dto);
  }

  @ApiOperation({
    summary:
      "Sign off the offline counter's journal (D11 missing-journal review)",
  })
  @RequirePermission(OFFLINE_ASSIGNMENT_MANAGER_PERMISSION)
  @Post("missing-journal")
  @HttpCode(200)
  signOff(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() dto: MissingJournalSignOffDto,
  ) {
    return this.recovery.signOffMissingJournal(user, branchId, dto);
  }
}
