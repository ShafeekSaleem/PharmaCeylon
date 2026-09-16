import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from "@nestjs/common";
import { AccessService } from "../security/access.service";
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
  constructor(
    private readonly stocktakes: StocktakesService,
    private readonly access: AccessService,
  ) {}

  @RequirePermission("stocktakes.use")
  @Get()
  async list(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string) {
    return this.stocktakes.list(user.tenantId, branchId, await this.access.resolve(user, branchId));
  }

  @RequirePermission("stocktakes.use")
  @Get(":id")
  async getOne(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.stocktakes.getOne(user.tenantId, branchId, id, await this.access.resolve(user, branchId));
  }

  @RequirePermission("stocktakes.use")
  @Post()
  async create(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() dto: CreateStocktakeDto,
  ) {
    return this.stocktakes.create(
      user.tenantId,
      branchId,
      user.userId,
      dto,
      await this.access.resolve(user, branchId),
    );
  }

  @RequirePermission("stocktakes.use")
  @Patch(":id")
  async updateHeader(
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
      await this.access.resolve(user, branchId),
    );
  }

  @RequirePermission("stocktakes.use")
  @Patch(":id/lines")
  async upsertLines(
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
      await this.access.resolve(user, branchId),
    );
  }

  @RequirePermission("stocktakes.use")
  @Post(":id/lines/add")
  async addLines(
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
      await this.access.resolve(user, branchId),
    );
  }

  @RequirePermission("stocktakes.use")
  @Post(":id/lines/remove")
  async removeLines(
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
      await this.access.resolve(user, branchId),
    );
  }

  @RequirePermission("stocktakes.use")
  @Post(":id/schedule")
  async schedule(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.stocktakes.schedule(
      user.tenantId,
      branchId,
      user.userId,
      id,
      await this.access.resolve(user, branchId),
    );
  }

  @RequirePermission("stocktakes.use")
  @Post(":id/start")
  async start(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.stocktakes.start(
      user.tenantId,
      branchId,
      user.userId,
      id,
      await this.access.resolve(user, branchId),
    );
  }

  @RequirePermission("stocktakes.use")
  @Post(":id/submit")
  async submit(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.stocktakes.submit(
      user.tenantId,
      branchId,
      user.userId,
      id,
      await this.access.resolve(user, branchId),
    );
  }

  @RequirePermission("stocktakes.review")
  @Post(":id/review/start")
  async startReview(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.stocktakes.startReview(
      user.tenantId,
      branchId,
      user.userId,
      id,
      await this.access.resolve(user, branchId),
    );
  }

  @RequirePermission("stocktakes.review")
  @Patch(":id/review-lines")
  async reviewLines(
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
      await this.access.resolve(user, branchId),
    );
  }

  @RequirePermission("stocktakes.review")
  @Post(":id/request-recount")
  async requestRecount(
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
      await this.access.resolve(user, branchId),
    );
  }

  @RequirePermission("stocktakes.review")
  @Post(":id/approve")
  async approve(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.stocktakes.approve(
      user.tenantId,
      branchId,
      user.userId,
      id,
      await this.access.resolve(user, branchId),
    );
  }

  @RequirePermission("stocktakes.review")
  @Post(":id/post")
  async post(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.stocktakes.post(
      user.tenantId,
      branchId,
      user.userId,
      id,
      await this.access.resolve(user, branchId),
    );
  }

  @RequirePermission("stocktakes.review")
  @Post(":id/complete")
  async complete(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.stocktakes.complete(
      user.tenantId,
      branchId,
      user.userId,
      await this.access.resolve(user, branchId),
      id,
    );
  }

  @RequirePermission("stocktakes.review")
  @Post(":id/cancel")
  async cancel(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.stocktakes.cancel(
      user.tenantId,
      branchId,
      user.userId,
      await this.access.resolve(user, branchId),
      id,
    );
  }
}
