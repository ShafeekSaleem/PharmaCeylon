import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from "@nestjs/common";
import { RoleName } from "@prisma/client";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { Roles } from "../security/decorators/roles.decorator";
import { RequireBranchId } from "../security/decorators/require-branch.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { CreateStocktakeDto } from "./dto/create-stocktake.dto";
import { UpsertStocktakeLinesDto } from "./dto/upsert-stocktake-lines.dto";
import {
  AddStocktakeLinesDto,
  RemoveStocktakeLinesDto,
  UpdateStocktakeDto,
} from "./dto/update-stocktake.dto";
import { StocktakesService } from "./stocktakes.service";

@Controller("stocktakes")
export class StocktakesController {
  constructor(private readonly stocktakes: StocktakesService) {}

  private rolesAtBranch(user: RequestUser, branchId: string): RoleName[] {
    const hasOwner = user.branchRoles.some((entry) => entry.role === RoleName.owner);
    const atBranch = user.branchRoles
      .filter((entry) => entry.branchId === branchId)
      .map((entry) => entry.role);
    if (hasOwner) {
      return [...new Set([...atBranch, RoleName.owner])];
    }
    return [...new Set(atBranch)];
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Get()
  list(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string) {
    return this.stocktakes.list(user.tenantId, branchId);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Get(":id")
  getOne(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.stocktakes.getOne(user.tenantId, branchId, id);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Post()
  create(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() dto: CreateStocktakeDto,
  ) {
    return this.stocktakes.create(user.tenantId, branchId, user.userId, dto);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Patch(":id")
  updateHeader(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateStocktakeDto,
  ) {
    return this.stocktakes.updateHeader(user.tenantId, branchId, user.userId, id, dto);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Patch(":id/lines")
  upsertLines(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpsertStocktakeLinesDto,
  ) {
    return this.stocktakes.upsertLines(user.tenantId, branchId, user.userId, id, dto);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Post(":id/lines/add")
  addLines(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: AddStocktakeLinesDto,
  ) {
    return this.stocktakes.addLines(user.tenantId, branchId, user.userId, id, dto);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Post(":id/lines/remove")
  removeLines(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: RemoveStocktakeLinesDto,
  ) {
    return this.stocktakes.removeLines(user.tenantId, branchId, user.userId, id, dto);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Post(":id/refresh-system")
  refreshSystem(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.stocktakes.refreshSystemQty(user.tenantId, branchId, user.userId, id);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Post(":id/match-uncounted")
  matchUncounted(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.stocktakes.matchUncounted(user.tenantId, branchId, user.userId, id);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Post(":id/start")
  start(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.stocktakes.start(user.tenantId, branchId, user.userId, id);
  }

  @Roles(RoleName.owner, RoleName.manager)
  @Post(":id/complete")
  complete(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.stocktakes.complete(
      user.tenantId,
      branchId,
      user.userId,
      this.rolesAtBranch(user, branchId),
      id,
    );
  }

  @Roles(RoleName.owner, RoleName.manager)
  @Post(":id/cancel")
  cancel(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.stocktakes.cancel(
      user.tenantId,
      branchId,
      user.userId,
      this.rolesAtBranch(user, branchId),
      id,
    );
  }
}
