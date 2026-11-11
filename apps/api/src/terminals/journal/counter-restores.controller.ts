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
import { IsString, Matches, MaxLength } from "class-validator";
import { CurrentUser } from "../../security/decorators/current-user.decorator";
import { RequireBranchId } from "../../security/decorators/require-branch.decorator";
import { RequirePermission } from "../../security/decorators/require-permission.decorator";
import type { RequestUser } from "../../security/interfaces/authenticated-request.interface";
import { OFFLINE_ASSIGNMENT_MANAGER_PERMISSION } from "../offline-assignment.service";
import { OfflineCounterRestoreService } from "./counter-restore.service";

export class AcknowledgeCounterRestoreDto {
  /** How receipts, cash and stock after the backup were checked, or why nothing was missing. */
  @IsString()
  @Matches(/\S/)
  @MaxLength(1000)
  reason!: string;
}

/**
 * P5 #51, store backup and restore (decisions of 2026-11-10), remote management: the counters at
 * this branch that restored their store from a backup, and acknowledging a restore so the counter
 * may be issued offline authority again. `tenant.management` is the route gate; acknowledging
 * additionally needs revised D13 authority (an owner, or a manager with the owner's live
 * delegation for the branch). Nothing here changes a counter or issues authority.
 */
@ApiTags("offline-counter-restores")
@Controller("offline-counter-restores")
export class OfflineCounterRestoresController {
  constructor(private readonly restores: OfflineCounterRestoreService) {}

  @ApiOperation({
    summary: "Counters at this branch that restored their store from a backup",
  })
  @RequirePermission(OFFLINE_ASSIGNMENT_MANAGER_PERMISSION)
  @Get()
  list(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string) {
    return this.restores.list(user, branchId);
  }

  @ApiOperation({
    summary:
      "Acknowledge a counter's store restore after checking what it lost",
  })
  @RequirePermission(OFFLINE_ASSIGNMENT_MANAGER_PERMISSION)
  @Post(":id/acknowledge")
  @HttpCode(200)
  acknowledge(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: AcknowledgeCounterRestoreDto,
  ) {
    return this.restores.acknowledge(user, branchId, id, dto);
  }
}
