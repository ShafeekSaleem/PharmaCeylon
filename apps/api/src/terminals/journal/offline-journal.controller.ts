import { Body, Controller, HttpCode, Post, UseFilters } from "@nestjs/common";
import { CounterRoute } from "../../security/decorators/counter-route.decorator";
import { CurrentUser } from "../../security/decorators/current-user.decorator";
import { RequireBranchId } from "../../security/decorators/require-branch.decorator";
import { RequirePermission } from "../../security/decorators/require-permission.decorator";
import type { RequestUser } from "../../security/interfaces/authenticated-request.interface";
import { TerminalErrorFilter } from "../terminal-error.filter";
import { OfflineJournalService } from "./offline-journal.service";

/**
 * P5 #51: the nominated counter uploads its offline journal (`SyncRequest`) and gets a signed
 * `SyncResponse` back. Every sign-in and command is device-signed; a revoked counter may still
 * upload to recover old evidence, which is kept for review rather than accepted.
 */
@UseFilters(TerminalErrorFilter)
@Controller("terminals/offline-journal")
export class OfflineJournalController {
  constructor(private readonly journal: OfflineJournalService) {}

  @CounterRoute()
  @RequirePermission("terminal.execute")
  @Post("sync")
  @HttpCode(200)
  sync(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string, @Body() raw: unknown) {
    return this.journal.sync(user, branchId, raw);
  }
}
