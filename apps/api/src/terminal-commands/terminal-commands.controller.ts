import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequireBranchId } from "../security/decorators/require-branch.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { TERMINAL_EXECUTE, TerminalCommandExecutor } from "./terminal-command.executor";

/** Signed physical execution for enrolled desktop counters (contract: docs/API_CONTRACT.md).
 * `terminal.execute` is only the route gate. Per-operation permissions, terminal proof,
 * attendance and approvals are enforced by the executor inside its transaction; production
 * attendance/hours providers still fail closed.
 */
@ApiTags("terminal-commands")
@Controller("terminal-commands")
export class TerminalCommandsController {
  constructor(private readonly executor: TerminalCommandExecutor) {}

  @RequirePermission(TERMINAL_EXECUTE)
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
  @Post("execute")
  @HttpCode(200)
  execute(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() body: unknown,
  ) {
    return this.executor.execute(user, branchId, body);
  }
}
