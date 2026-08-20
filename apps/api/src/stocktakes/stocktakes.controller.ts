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
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import { RequireBranchId } from "../security/decorators/require-branch.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { CreateStocktakeDto } from "./dto/create-stocktake.dto";
import { UpsertStocktakeLinesDto } from "./dto/upsert-stocktake-lines.dto";
import {
  AddStocktakeLinesDto,
  RemoveStocktakeLinesDto,
  RequestRecountDto,
  ReviewStocktakeLinesDto,
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

  @RequirePermission("stocktakes.use")
  @Get()
  list(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string) {
    return this.stocktakes.list(user.tenantId, branchId, this.rolesAtBranch(user, branchId));
  }

  @RequirePermission("stocktakes.use")
  @Get(":id")
  getOne(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.stocktakes.getOne(user.tenantId, branchId, id, this.rolesAtBranch(user, branchId));
  }

  @RequirePermission("stocktakes.use")
  @Post()
  create(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() dto: CreateStocktakeDto,
  ) {
    return this.stocktakes.create(
      user.tenantId,
      branchId,
      user.userId,
      dto,
      this.rolesAtBranch(user, branchId),
    );
  }

  @RequirePermission("stocktakes.use")
  @Patch(":id")
  updateHeader(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateStocktakeDto,
  ) {
    return this.stocktakes.updateHeader(
      user.tenantId,
      branchId,
      user.userId,
      id,
      dto,
      this.rolesAtBranch(user, branchId),
    );
  }

  @RequirePermission("stocktakes.use")
  @Patch(":id/lines")
  upsertLines(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpsertStocktakeLinesDto,
  ) {
    return this.stocktakes.upsertLines(
      user.tenantId,
      branchId,
      user.userId,
      id,
      dto,
      this.rolesAtBranch(user, branchId),
    );
  }

  @RequirePermission("stocktakes.use")
  @Post(":id/lines/add")
  addLines(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: AddStocktakeLinesDto,
  ) {
    return this.stocktakes.addLines(
      user.tenantId,
      branchId,
      user.userId,
      id,
      dto,
      this.rolesAtBranch(user, branchId),
    );
  }

  @RequirePermission("stocktakes.use")
  @Post(":id/lines/remove")
  removeLines(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: RemoveStocktakeLinesDto,
  ) {
    return this.stocktakes.removeLines(
      user.tenantId,
      branchId,
      user.userId,
      id,
      dto,
      this.rolesAtBranch(user, branchId),
    );
  }

  @RequirePermission("stocktakes.use")
  @Post(":id/schedule")
  schedule(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.stocktakes.schedule(
      user.tenantId,
      branchId,
      user.userId,
      id,
      this.rolesAtBranch(user, branchId),
    );
  }

  @RequirePermission("stocktakes.use")
  @Post(":id/start")
  start(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.stocktakes.start(
      user.tenantId,
      branchId,
      user.userId,
      id,
      this.rolesAtBranch(user, branchId),
    );
  }

  @RequirePermission("stocktakes.use")
  @Post(":id/submit")
  submit(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.stocktakes.submit(
      user.tenantId,
      branchId,
      user.userId,
      id,
      this.rolesAtBranch(user, branchId),
    );
  }

  @RequirePermission("stocktakes.review")
  @Post(":id/review/start")
  startReview(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.stocktakes.startReview(
      user.tenantId,
      branchId,
      user.userId,
      id,
      this.rolesAtBranch(user, branchId),
    );
  }

  @RequirePermission("stocktakes.review")
  @Patch(":id/review-lines")
  reviewLines(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ReviewStocktakeLinesDto,
  ) {
    return this.stocktakes.reviewLines(
      user.tenantId,
      branchId,
      user.userId,
      id,
      dto,
      this.rolesAtBranch(user, branchId),
    );
  }

  @RequirePermission("stocktakes.review")
  @Post(":id/request-recount")
  requestRecount(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: RequestRecountDto,
  ) {
    return this.stocktakes.requestRecount(
      user.tenantId,
      branchId,
      user.userId,
      id,
      dto,
      this.rolesAtBranch(user, branchId),
    );
  }

  @RequirePermission("stocktakes.review")
  @Post(":id/approve")
  approve(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.stocktakes.approve(
      user.tenantId,
      branchId,
      user.userId,
      id,
      this.rolesAtBranch(user, branchId),
    );
  }

  @RequirePermission("stocktakes.review")
  @Post(":id/post")
  post(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.stocktakes.post(
      user.tenantId,
      branchId,
      user.userId,
      id,
      this.rolesAtBranch(user, branchId),
    );
  }

  @RequirePermission("stocktakes.review")
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

  @RequirePermission("stocktakes.review")
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
