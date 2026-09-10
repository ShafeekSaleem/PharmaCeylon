import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequireBranchId } from "../security/decorators/require-branch.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { CreatePrescriptionDto } from "./dto/create-prescription.dto";
import { PrescriptionsService } from "./prescriptions.service";

@ApiTags("prescriptions")
@Controller("prescriptions")
export class PrescriptionsController {
  constructor(private readonly prescriptions: PrescriptionsService) {}

  @ApiOperation({ summary: "Search prescriptions at the active branch" })
  @RequirePermission("prescriptions.view")
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

  @ApiOperation({
    summary: "Paginated prescription register for the active branch",
    description:
      "Unlike the search endpoint, returns a total count and supports validity filtering.",
  })
  @RequirePermission("prescriptions.view")
  @Get("register")
  list(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("q") q?: string,
    @Query("validity") validity?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    return this.prescriptions.list(user.tenantId, branchId, {
      q,
      validity,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @RequirePermission("prescriptions.view")
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
  @RequirePermission("prescriptions.create")
  @Post()
  create(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() dto: CreatePrescriptionDto,
  ) {
    return this.prescriptions.create(user.tenantId, branchId, user.userId, dto);
  }
}
