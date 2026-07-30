import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { RoleName } from "@prisma/client";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequireBranchId } from "../security/decorators/require-branch.decorator";
import { Roles } from "../security/decorators/roles.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { CreatePrescriptionDto } from "./dto/create-prescription.dto";
import { PrescriptionsService } from "./prescriptions.service";

@ApiTags("prescriptions")
@Controller("prescriptions")
export class PrescriptionsController {
  constructor(private readonly prescriptions: PrescriptionsService) {}

  @ApiOperation({ summary: "Search prescriptions at the active branch" })
  @Roles(RoleName.owner, RoleName.manager, RoleName.pharmacist, RoleName.cashier)
  @Get()
  search(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("q") q?: string,
    @Query("customerId") customerId?: string,
    @Query("take") take?: string,
  ) {
    return this.prescriptions.search(user.tenantId, branchId, {
      q,
      customerId: customerId || undefined,
      take: take ? Number(take) : undefined,
    });
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.pharmacist, RoleName.cashier)
  @Get(":id")
  getOne(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.prescriptions.getOne(user.tenantId, branchId, id);
  }

  @ApiOperation({
    summary: "Record a prescription presented at the counter (pharmacist and above)",
  })
  @Roles(RoleName.owner, RoleName.manager, RoleName.pharmacist)
  @Post()
  create(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() dto: CreatePrescriptionDto,
  ) {
    return this.prescriptions.create(user.tenantId, branchId, user.userId, dto);
  }
}
