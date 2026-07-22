import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { RoleName } from "@prisma/client";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { Roles } from "../security/decorators/roles.decorator";
import { RequireBranchId } from "../security/decorators/require-branch.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { CreateTransferDto } from "./dto/create-transfer.dto";
import { ReceiveTransferDto } from "./dto/receive-transfer.dto";
import { TransfersService } from "./transfers.service";

@Controller("transfers")
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

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

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Get()
  list(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string) {
    return this.transfers.list(user.tenantId, branchId);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Get(":id")
  getOne(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.transfers.getOne(user.tenantId, branchId, id);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Post()
  create(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() fromBranchId: string,
    @Body() dto: CreateTransferDto,
  ) {
    return this.transfers.create(
      user.tenantId,
      fromBranchId,
      user.userId,
      this.rolesAtBranch(user, fromBranchId),
      dto,
    );
  }

  @Roles(RoleName.owner, RoleName.manager)
  @Post(":id/approve")
  approve(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() fromBranchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.transfers.approve(
      user.tenantId,
      fromBranchId,
      user.userId,
      id,
      this.rolesAtBranch(user, fromBranchId),
    );
  }

  @Roles(RoleName.owner, RoleName.manager)
  @Post(":id/reject")
  reject(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() fromBranchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.transfers.reject(
      user.tenantId,
      fromBranchId,
      user.userId,
      id,
      this.rolesAtBranch(user, fromBranchId),
    );
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Post(":id/cancel")
  cancel(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() fromBranchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.transfers.cancel(
      user.tenantId,
      fromBranchId,
      user.userId,
      id,
      this.rolesAtBranch(user, fromBranchId),
    );
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Post(":id/ship")
  ship(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() fromBranchId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
  ) {
    return this.transfers.ship(user.tenantId, fromBranchId, user.userId, id, idempotencyKey);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Post(":id/receive")
  receive(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() toBranchId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ReceiveTransferDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
  ) {
    return this.transfers.receive(
      user.tenantId,
      toBranchId,
      user.userId,
      id,
      dto ?? {},
      idempotencyKey,
    );
  }
}
