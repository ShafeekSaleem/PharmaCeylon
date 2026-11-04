import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { CounterRoute } from "../security/decorators/counter-route.decorator";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequireBranchId } from "../security/decorators/require-branch.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { CounterWorkService } from "./counter-work.service";
import { TERMINAL_EXECUTE } from "./terminal-command.executor";

/**
 * Revised D10: work approved on the web that only this branch's counter may execute. Read-only;
 * executing goes through `terminal-commands`. `terminal.execute` gates the route, and each kind
 * is listed only to someone holding that operation's own permission at the branch.
 */
@ApiTags("terminal-commands")
@Controller("counter-work")
export class CounterWorkController {
  constructor(private readonly work: CounterWorkService) {}

  @ApiOperation({ summary: "Web-approved work waiting at this branch's counter, with its approval state" })
  @RequirePermission(TERMINAL_EXECUTE)
  @CounterRoute()
  @Get()
  list(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string) {
    return this.work.list(user, branchId);
  }
}
