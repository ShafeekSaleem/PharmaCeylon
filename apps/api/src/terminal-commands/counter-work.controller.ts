import { BadRequestException, Controller, Get, Param, ParseUUIDPipe, Res, UseFilters } from "@nestjs/common";
import type { Response } from "express";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { CounterRoute } from "../security/decorators/counter-route.decorator";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequireBranchId } from "../security/decorators/require-branch.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { TerminalErrorFilter } from "../terminals/terminal-error.filter";
import {
  COUNTER_WORK_AS_OF_HEADER,
  COUNTER_WORK_CONTRACT_VERSION,
  COUNTER_WORK_CONTRACT_VERSION_HEADER,
  COUNTER_WORK_DETAIL_KINDS,
  isCounterWorkDetailKind,
} from "@pharmaceylon/shared";
import { CounterWorkDetailService } from "./counter-work-detail.service";
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
  constructor(
    private readonly work: CounterWorkService,
    private readonly details: CounterWorkDetailService,
  ) {}

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
    res.setHeader(COUNTER_WORK_AS_OF_HEADER, asOf);
    res.setHeader(COUNTER_WORK_CONTRACT_VERSION_HEADER, String(COUNTER_WORK_CONTRACT_VERSION));
    return this.work.list(user, branchId, asOf);
  }

  /** Decision 5: imports this counter can still undo. Declared before `:kind/:id`. */
  @ApiOperation({ summary: "Imports this branch's counter can still undo, with the stock each posted" })
  @RequirePermission(TERMINAL_EXECUTE)
  @CounterRoute()
  @Get("imports")
  imports(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string) {
    return this.details.undoableImports(user, branchId);
  }

  /**
   * The lines behind one item, for the operation screen. 404 once it has left this branch's
   * Counter work; 403 without the operation's own permission.
   */
  @ApiOperation({ summary: "One Counter work item with its lines, trail and notes" })
  @RequirePermission(TERMINAL_EXECUTE)
  @CounterRoute()
  @Get(":kind/:id")
  async detail(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("kind") kind: string,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!isCounterWorkDetailKind(kind))
      throw new BadRequestException(`kind must be one of: ${COUNTER_WORK_DETAIL_KINDS.join(", ")}`);
    const asOf = new Date().toISOString();
    res.setHeader(COUNTER_WORK_AS_OF_HEADER, asOf);
    res.setHeader(COUNTER_WORK_CONTRACT_VERSION_HEADER, String(COUNTER_WORK_CONTRACT_VERSION));
    return this.details.detail(user, branchId, kind, id, asOf);
  }
}
