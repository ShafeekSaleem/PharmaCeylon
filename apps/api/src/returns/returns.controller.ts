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
import { RoleName } from "@prisma/client";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import { RequireBranchId } from "../security/decorators/require-branch.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { CreateReturnDto } from "./dto/create-return.dto";
import { UpdateReturnDto } from "./dto/update-return.dto";
import { ReturnsService } from "./returns.service";

@Controller("returns")
export class ReturnsController {
  constructor(private readonly returns: ReturnsService) {}

  /** Roles at the active branch; owners are treated as having owner at every branch. */
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
  create(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() dto: CreateReturnDto,
  ) {
    return this.returns.create(
      user.tenantId,
      branchId,
      user.userId,
      this.rolesAtBranch(user, branchId),
      dto,
    );
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
  submit(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.returns.submit(
      user.tenantId,
      branchId,
      user.userId,
      id,
      this.rolesAtBranch(user, branchId),
    );
  }

  @RequirePermission("returns.approve")
  @Post(":id/approve")
  approve(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.returns.approve(
      user.tenantId,
      branchId,
      user.userId,
      id,
      this.rolesAtBranch(user, branchId),
    );
  }

  @RequirePermission("returns.approve")
  @Post(":id/reject")
  reject(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.returns.reject(
      user.tenantId,
      branchId,
      user.userId,
      id,
      this.rolesAtBranch(user, branchId),
    );
  }

  @RequirePermission("returns.process")
  @Post(":id/mark-logistics")
  markLogistics(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.returns.markLogistics(
      user.tenantId,
      branchId,
      user.userId,
      id,
      this.rolesAtBranch(user, branchId),
    );
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
  cancel(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.returns.cancel(
      user.tenantId,
      branchId,
      user.userId,
      id,
      this.rolesAtBranch(user, branchId),
    );
  }
}
