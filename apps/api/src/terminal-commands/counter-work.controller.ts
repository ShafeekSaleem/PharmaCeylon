import { Controller, Get, Res, UseFilters } from "@nestjs/common";
import type { Response } from "express";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { CounterRoute } from "../security/decorators/counter-route.decorator";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequireBranchId } from "../security/decorators/require-branch.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { TerminalErrorFilter } from "../terminals/terminal-error.filter";
import { COUNTER_WORK_CONTRACT_VERSION } from "@pharmaceylon/shared";
import { CounterWorkService } from "./counter-work.service";
import { TERMINAL_EXECUTE } from "./terminal-command.executor";

/**
 * Revised D10: work approved on the web that only this branch's counter may execute. Read-only;
 * executing goes through `terminal-commands`. `terminal.execute` gates the route, and each kind
 * is listed only to someone holding that operation's own permission at the branch.
 */
@ApiTags("terminal-commands")
@UseFilters(TerminalErrorFilter)
@Controller("counter-work")
export class CounterWorkController {
  constructor(private readonly work: CounterWorkService) {}

  @ApiOperation({ summary: "Web-approved work waiting at this branch's counter, with its approval state" })
  @RequirePermission(TERMINAL_EXECUTE)
  @CounterRoute()
  @Get()
  async list(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const asOf = new Date().toISOString();
    res.setHeader("X-PharmaCeylon-Counter-Work-As-Of", asOf);
    res.setHeader("X-PharmaCeylon-Counter-Work-Contract-Version", String(COUNTER_WORK_CONTRACT_VERSION));
    return this.work.list(user, branchId, asOf);
  }
}
