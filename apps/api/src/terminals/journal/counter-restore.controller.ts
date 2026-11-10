import { Body, Controller, HttpCode, Post, UseFilters } from "@nestjs/common";
import { CounterRoute } from "../../security/decorators/counter-route.decorator";
import { CurrentUser } from "../../security/decorators/current-user.decorator";
import { RequireBranchId } from "../../security/decorators/require-branch.decorator";
import { RequirePermission } from "../../security/decorators/require-permission.decorator";
import type { RequestUser } from "../../security/interfaces/authenticated-request.interface";
import { TerminalErrorFilter } from "../terminal-error.filter";
import { OfflineCounterRestoreService } from "./counter-restore.service";

/**
 * P5 #51, store backup and restore: a restored counter reports its restore and asks whether it
 * was acknowledged. Same uploader rule as `POST /terminals/offline-journal/sync`; the report is
 * device-signed. Neither route accepts a journal entry or issues authority.
 */
@UseFilters(TerminalErrorFilter)
@Controller("terminals/offline-journal/restore")
export class OfflineCounterRestoreController {
  constructor(private readonly restores: OfflineCounterRestoreService) {}

  @CounterRoute()
  @RequirePermission("terminal.execute")
  @Post("report")
  @HttpCode(200)
  report(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() raw: unknown,
  ) {
    return this.restores.report(user, branchId, raw);
  }

  @CounterRoute()
  @RequirePermission("terminal.execute")
  @Post("status")
  @HttpCode(200)
  status(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() raw: unknown,
  ) {
    return this.restores.status(user, branchId, raw);
  }
}
