import {
  Body,
  Controller,
  Get,
  Headers,
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
import { CreateReturnDto } from "./dto/create-return.dto";
import { UpdateReturnDto } from "./dto/update-return.dto";
import { ReturnsService } from "./returns.service";

@Controller("returns")
export class ReturnsController {
  constructor(
    private readonly returns: ReturnsService,
    private readonly access: AccessService,
  ) {}

  @RequirePermission("returns.view")
  @Get()
  list(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string) {
    return this.returns.list(user.tenantId, branchId);
  }

  @RequirePermission("returns.view")
  @Get(":id")
  getOne(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.returns.getOne(user.tenantId, branchId, id);
  }

  @RequirePermission("returns.create")
  @Post()
  async create(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() dto: CreateReturnDto,
  ) {
    const access = await this.access.resolve(user, branchId);
    return this.returns.create(user.tenantId, branchId, access, dto);
  }

  @RequirePermission("returns.process")
  @Patch(":id")
  update(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateReturnDto,
  ) {
    return this.returns.update(user.tenantId, branchId, user.userId, id, dto);
  }

  @RequirePermission("returns.process")
  @Post(":id/submit")
  async submit(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    const access = await this.access.resolve(user, branchId);
    return this.returns.submit(user.tenantId, branchId, access, id);
  }

  @RequirePermission("returns.approve")
  @Post(":id/approve")
  async approve(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    const access = await this.access.resolve(user, branchId);
    return this.returns.approve(user.tenantId, branchId, access, id);
  }

  @RequirePermission("returns.approve")
  @Post(":id/reject")
  reject(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.returns.reject(user.tenantId, branchId, user.userId, id);
  }

  @RequirePermission("returns.process")
  @Post(":id/mark-logistics")
  async markLogistics(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    const access = await this.access.resolve(user, branchId);
    return this.returns.markLogistics(user.tenantId, branchId, access, id);
  }

  @RequirePermission("returns.process")
  @Post(":id/complete")
  complete(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
  ) {
    return this.returns.complete(
      user.tenantId,
      branchId,
      user.userId,
      id,
      idempotencyKey,
    );
  }

  @RequirePermission("returns.process")
  @Post(":id/cancel")
  async cancel(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    const access = await this.access.resolve(user, branchId);
    return this.returns.cancel(user.tenantId, branchId, access, id);
  }
}
