import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { RoleName } from "@prisma/client";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { Roles } from "../security/decorators/roles.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { CreateSupplierDto } from "./dto/create-supplier.dto";
import { UpdateSupplierDto } from "./dto/update-supplier.dto";
import { CreateSupplierInvoiceDto } from "./dto/create-supplier-invoice.dto";
import { RecordSupplierPaymentDto } from "./dto/record-supplier-payment.dto";
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
  list(
    @CurrentUser() user: RequestUser,
    @Query("q") q?: string,
    @Query("status") status?: string,
    @Query("type") type?: string,
    @Query("paymentTermsDays") paymentTermsDays?: string,
  ) {
    return this.suppliers.list(user.tenantId, { q, status, type, paymentTermsDays });
  }

  @Roles(
    RoleName.owner,
    RoleName.manager,
    RoleName.inventory_clerk,
    RoleName.analyst,
    RoleName.pharmacist,
  )
  @Get("summary")
  summary(@CurrentUser() user: RequestUser, @Query("period") period?: string) {
    return this.suppliers.summary(user.tenantId, period);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Post("invoices/:id/payments")
  recordPayment(
    @CurrentUser() user: RequestUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: RecordSupplierPaymentDto,
  ) {
    return this.suppliers.recordPayment(user.tenantId, user.userId, id, dto);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Post()
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateSupplierDto) {
    return this.suppliers.create(user.tenantId, user.userId, dto);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Post(":id/invoices")
  createInvoice(
    @CurrentUser() user: RequestUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: CreateSupplierInvoiceDto,
  ) {
    return this.suppliers.createInvoice(user.tenantId, user.userId, id, dto);
  }

  @Roles(
    RoleName.owner,
    RoleName.manager,
    RoleName.inventory_clerk,
    RoleName.analyst,
    RoleName.pharmacist,
  )
  @Get(":id")
  getOne(@CurrentUser() user: RequestUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.suppliers.getById(user.tenantId, id);
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
