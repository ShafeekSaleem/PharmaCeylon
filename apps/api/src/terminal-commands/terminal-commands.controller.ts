import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequireBranchId } from "../security/decorators/require-branch.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { TerminalCommandExecutor } from "./terminal-command.executor";

/** Signed physical execution for enrolled desktop counters (contract: docs/API_CONTRACT.md).
 * Per-operation permissions, terminal proof, attendance and approvals are enforced by the
 * executor inside its transaction; production attendance/hours providers still fail closed.
 */
@ApiTags("terminal-commands")
@Controller("terminal-commands")
export class TerminalCommandsController {
  constructor(private readonly executor: TerminalCommandExecutor) {}

  @Post("prepare")
  @HttpCode(200)
  prepare(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() body: unknown,
  ) {
    return this.executor.prepare(user, branchId, body);
  }

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
