import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseFilters,
} from "@nestjs/common";
import { CounterRoute } from "../../security/decorators/counter-route.decorator";
import { CurrentUser } from "../../security/decorators/current-user.decorator";
import { RequireBranchId } from "../../security/decorators/require-branch.decorator";
import { RequirePermission } from "../../security/decorators/require-permission.decorator";
import type { RequestUser } from "../../security/interfaces/authenticated-request.interface";
import { TerminalErrorFilter } from "../terminal-error.filter";
import { OfflineJournalRecoveryService } from "./journal-recovery.service";

/**
 * P5 #51, D11: a restored counter's side of journal recovery. Same uploader rule as
 * `POST /terminals/offline-journal/sync`; everything the counter states is device-signed. None
 * of these routes accepts a journal entry or issues authority.
 */
@UseFilters(TerminalErrorFilter)
@Controller("terminals/offline-journal/recovery")
export class OfflineJournalRecoveryController {
  constructor(private readonly recovery: OfflineJournalRecoveryService) {}

  /** The accepted entries after a sequence, so the counter can find and restore what it lost. */
  @CounterRoute()
  @RequirePermission("terminal.execute")
  @Post("chain")
  @HttpCode(200)
  chain(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() raw: unknown,
  ) {
    return this.recovery.chain(user, branchId, raw);
  }

  @CounterRoute()
  @RequirePermission("terminal.execute")
  @Post("report")
  @HttpCode(200)
  report(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() raw: unknown,
  ) {
    return this.recovery.report(user, branchId, raw);
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
    return this.recovery.status(user, branchId, raw);
  }

  @CounterRoute()
  @RequirePermission("terminal.execute")
  @Post(":recoveryId/complete")
  @HttpCode(200)
  complete(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("recoveryId", ParseUUIDPipe) recoveryId: string,
    @Body() raw: unknown,
  ) {
    return this.recovery.complete(user, branchId, recoveryId, raw);
  }
}
