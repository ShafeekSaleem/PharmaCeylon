import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { RoleName } from "@prisma/client";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { Roles } from "../security/decorators/roles.decorator";
import { RequireBranchId } from "../security/decorators/require-branch.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { CreateTransferDto } from "./dto/create-transfer.dto";
import { TransfersService } from "./transfers.service";

@Controller("transfers")
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Get()
  list(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string) {
    return this.transfers.list(user.tenantId, branchId);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Post()
  create(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() fromBranchId: string,
    @Body() dto: CreateTransferDto,
  ) {
    return this.transfers.create(user.tenantId, fromBranchId, user.userId, dto);
  }

  @Roles(RoleName.owner, RoleName.manager)
  @Post(":id/approve")
  approve(@CurrentUser() user: RequestUser, @Param("id", ParseUUIDPipe) id: string) {
    const roles = [...new Set(user.branchRoles.map((r) => r.role))];
    return this.transfers.approve(user.tenantId, user.userId, id, roles);
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
    @Headers("idempotency-key") idempotencyKey: string | undefined,
  ) {
    return this.transfers.receive(user.tenantId, toBranchId, user.userId, id, idempotencyKey);
  }
}
