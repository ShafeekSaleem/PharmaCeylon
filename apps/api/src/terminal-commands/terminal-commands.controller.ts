import { Body, Controller, HttpCode, Post, UseFilters } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CounterRoute } from "../security/decorators/counter-route.decorator";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequireBranchId } from "../security/decorators/require-branch.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { TerminalErrorFilter } from "../terminals/terminal-error.filter";
import { PharmacistCosigns } from "./pharmacist-cosigns.service";
import { TERMINAL_EXECUTE, TerminalCommandExecutor } from "./terminal-command.executor";

/** Signed physical execution for enrolled desktop counters (contract: docs/API_CONTRACT.md).
 * `terminal.execute` is only the route gate. Per-operation permissions, terminal proof,
 * attendance and approvals are enforced by the executor inside its transaction; production
 * attendance/hours providers still fail closed.
 */
@ApiTags("terminal-commands")
@UseFilters(TerminalErrorFilter)
@Controller("terminal-commands")
export class TerminalCommandsController {
  constructor(
    private readonly executor: TerminalCommandExecutor,
    private readonly cosigns: PharmacistCosigns,
  ) {}

  @RequirePermission(TERMINAL_EXECUTE)
  @CounterRoute()
  @Post("prepare")
  @HttpCode(200)
  prepare(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() body: unknown,
  ) {
    return this.executor.prepare(user, branchId, body);
  }

  @RequirePermission(TERMINAL_EXECUTE)
  @CounterRoute()
  @Post("execute")
  @HttpCode(200)
  execute(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() body: unknown,
  ) {
    return this.executor.execute(user, branchId, body);
  }

  /** A registered pharmacist's PIN co-sign for one clinical command (prescriptions), for the person
   * signed in at this counter. The command then carries only `pharmacistEvidenceId`. */
  @RequirePermission(TERMINAL_EXECUTE)
  @CounterRoute()
  @Post("pharmacist-cosigns")
  @HttpCode(200)
  cosign(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() body: unknown,
  ) {
    return this.cosigns.issue(user, branchId, body);
  }
}
