import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { CounterRoute } from "../../security/decorators/counter-route.decorator";
import { CurrentUser } from "../../security/decorators/current-user.decorator";
import { RequireBranchId } from "../../security/decorators/require-branch.decorator";
import { RequirePermission } from "../../security/decorators/require-permission.decorator";
import { RequestUser } from "../../security/interfaces/authenticated-request.interface";
import { TerminalErrorFilter } from "../terminal-error.filter";
import { CloseTillShiftDto, OpenTillShiftDto } from "./till-shift.dto";
import { TillShiftsService } from "./till-shifts.service";

/** Opening and closing your own shift is part of selling at the counter. */
const POS = "sales.pos_use";

/**
 * Till shifts at an enrolled counter (P2b #103; contract: docs/API_CONTRACT.md, "Till shifts").
 * Every route runs on the caller's own open staff session (`:workSessionId` is the sign-in), so
 * the till is the session's, never a client claim. The closing manager's extra authority for
 * someone else's shift (`shifts.close_others`) is checked live inside the transaction.
 */
@ApiTags("terminals")
@UseFilters(TerminalErrorFilter)
@Controller("terminals")
export class TillShiftsController {
  constructor(private readonly shifts: TillShiftsService) {}

  @CounterRoute()
  @RequirePermission(POS)
  @Get("sessions/:workSessionId/shifts/current")
  current(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("workSessionId", ParseUUIDPipe) workSessionId: string,
  ) {
    return this.shifts.current(user, branchId, workSessionId);
  }

  @CounterRoute()
  @RequirePermission(POS)
  @Get("sessions/:workSessionId/shifts")
  list(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("workSessionId", ParseUUIDPipe) workSessionId: string,
  ) {
    return this.shifts.list(user, branchId, workSessionId);
  }

  @CounterRoute()
  @RequirePermission(POS)
  @Get("sessions/:workSessionId/shifts/:shiftId")
  detail(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("workSessionId", ParseUUIDPipe) workSessionId: string,
    @Param("shiftId", ParseUUIDPipe) shiftId: string,
  ) {
    return this.shifts.detail(user, branchId, workSessionId, shiftId);
  }

  // Both check a PIN; the per-account lockout is the real limit, this caps the rate.
  @CounterRoute()
  @RequirePermission(POS)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("sessions/:workSessionId/shifts")
  @HttpCode(200)
  open(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("workSessionId", ParseUUIDPipe) workSessionId: string,
    @Body() dto: OpenTillShiftDto,
  ) {
    return this.shifts.open(user, branchId, workSessionId, dto);
  }

  @CounterRoute()
  @RequirePermission(POS)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("sessions/:workSessionId/shifts/:shiftId/close")
  @HttpCode(200)
  close(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("workSessionId", ParseUUIDPipe) workSessionId: string,
    @Param("shiftId", ParseUUIDPipe) shiftId: string,
    @Body() dto: CloseTillShiftDto,
  ) {
    return this.shifts.close(user, branchId, workSessionId, shiftId, dto);
  }
}
