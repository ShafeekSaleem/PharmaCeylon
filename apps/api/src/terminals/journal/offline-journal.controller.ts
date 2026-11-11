import { Body, Controller, Get, HttpCode, Post, UseFilters } from "@nestjs/common";
import { CounterRoute } from "../../security/decorators/counter-route.decorator";
import { CurrentUser } from "../../security/decorators/current-user.decorator";
import { RequireBranchId } from "../../security/decorators/require-branch.decorator";
import { RequirePermission } from "../../security/decorators/require-permission.decorator";
import type { RequestUser } from "../../security/interfaces/authenticated-request.interface";
import { TerminalErrorFilter } from "../terminal-error.filter";
import { CounterJournalStatusService } from "./counter-journal-status.service";
import { OfflineJournalService } from "./offline-journal.service";

/**
 * P5 #51: the nominated counter uploads its offline journal (`SyncRequest`) and gets a signed
 * `SyncResponse` back. Every sign-in and command is device-signed; a revoked counter may still
 * upload to recover old evidence, which is kept for review rather than accepted.
 */
@UseFilters(TerminalErrorFilter)
@Controller("terminals/offline-journal")
export class OfflineJournalController {
  constructor(
    private readonly journal: OfflineJournalService,
    private readonly status: CounterJournalStatusService,
  ) {}

  @CounterRoute()
  @RequirePermission("terminal.execute")
  @Post("sync")
  @HttpCode(200)
  sync(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string, @Body() raw: unknown) {
    return this.journal.sync(user, branchId, raw);
  }

  /** How far each counter's journal has reached the server (web Counters page). */
  @RequirePermission("tenant.management")
  @Get("sync-status")
  syncStatus(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string) {
    return this.status.list(user, branchId);
  }
}
