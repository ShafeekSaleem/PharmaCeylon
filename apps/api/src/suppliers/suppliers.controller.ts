import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { RoleName } from "@prisma/client";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { Roles } from "../security/decorators/roles.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { CreateSupplierDto } from "./dto/create-supplier.dto";
import { UpdateSupplierDto } from "./dto/update-supplier.dto";
import { SuppliersService } from "./suppliers.service";

@Controller("suppliers")
export class SuppliersController {
  constructor(private readonly suppliers: SuppliersService) {}

  @Roles(
    RoleName.owner,
    RoleName.manager,
    RoleName.inventory_clerk,
    RoleName.analyst,
    RoleName.pharmacist,
  )
  @Get()
  list(@CurrentUser() user: RequestUser) {
    return this.suppliers.list(user.tenantId);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk, RoleName.analyst)
  @Get(":id")
  getOne(@CurrentUser() user: RequestUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.suppliers.getById(user.tenantId, id);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Post()
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateSupplierDto) {
    return this.suppliers.create(user.tenantId, user.userId, dto);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Patch(":id")
  update(
    @CurrentUser() user: RequestUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateSupplierDto,
  ) {
    return this.suppliers.update(user.tenantId, user.userId, id, dto);
  }
}
