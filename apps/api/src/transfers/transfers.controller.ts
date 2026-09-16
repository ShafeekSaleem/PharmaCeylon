import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { AccessService } from "../security/access.service";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import { RequireBranchId } from "../security/decorators/require-branch.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { CreateTransferDto } from "./dto/create-transfer.dto";
import { ReceiveTransferDto } from "./dto/receive-transfer.dto";
import { TransfersService } from "./transfers.service";

@Controller("transfers")
export class TransfersController {
  constructor(
    private readonly transfers: TransfersService,
    private readonly access: AccessService,
  ) {}

  @RequirePermission("transfers.view")
  @Get()
  list(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string) {
    return this.transfers.list(user.tenantId, branchId);
  }

  @RequirePermission("transfers.view")
  @Get(":id")
  getOne(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.transfers.getOne(user.tenantId, branchId, id);
  }

  @RequirePermission("transfers.manage")
  @Post()
  async create(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() fromBranchId: string,
    @Body() dto: CreateTransferDto,
  ) {
    const access = await this.access.resolve(user, fromBranchId);
    return this.transfers.create(user.tenantId, fromBranchId, access, dto);
  }

  @RequirePermission("transfers.approve")
  @Post(":id/approve")
  async approve(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() fromBranchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    const access = await this.access.resolve(user, fromBranchId);
    return this.transfers.approve(user.tenantId, fromBranchId, access, id);
  }

  @RequirePermission("transfers.approve")
  @Post(":id/reject")
  reject(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() fromBranchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.transfers.reject(user.tenantId, fromBranchId, user.userId, id);
  }

  @RequirePermission("transfers.manage")
  @Post(":id/cancel")
  async cancel(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() fromBranchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    const access = await this.access.resolve(user, fromBranchId);
    return this.transfers.cancel(user.tenantId, fromBranchId, access, id);
  }

  @RequirePermission("transfers.manage")
  @Post(":id/ship")
  ship(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() fromBranchId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
  ) {
    return this.transfers.ship(user.tenantId, fromBranchId, user.userId, id, idempotencyKey);
  }

  @RequirePermission("transfers.manage")
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
