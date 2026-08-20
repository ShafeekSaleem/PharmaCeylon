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
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { CreateSupplierDto } from "./dto/create-supplier.dto";
import { UpdateSupplierDto } from "./dto/update-supplier.dto";
import { CreateSupplierInvoiceDto } from "./dto/create-supplier-invoice.dto";
import { RecordSupplierPaymentDto } from "./dto/record-supplier-payment.dto";
import { SuppliersService } from "./suppliers.service";

@Controller("suppliers")
export class SuppliersController {
  constructor(private readonly suppliers: SuppliersService) {}

  @RequirePermission("suppliers.view")
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

  @RequirePermission("suppliers.view")
  @Get("summary")
  summary(@CurrentUser() user: RequestUser, @Query("period") period?: string) {
    return this.suppliers.summary(user.tenantId, period);
  }

  @RequirePermission("suppliers.manage")
  @Post("invoices/:id/payments")
  recordPayment(
    @CurrentUser() user: RequestUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: RecordSupplierPaymentDto,
  ) {
    return this.suppliers.recordPayment(user.tenantId, user.userId, id, dto);
  }

  @RequirePermission("suppliers.manage")
  @Post()
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateSupplierDto) {
    return this.suppliers.create(user.tenantId, user.userId, dto);
  }

  @RequirePermission("suppliers.manage")
  @Post(":id/invoices")
  createInvoice(
    @CurrentUser() user: RequestUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: CreateSupplierInvoiceDto,
  ) {
    return this.suppliers.createInvoice(user.tenantId, user.userId, id, dto);
  }

  @RequirePermission("suppliers.view")
  @Get(":id")
  getOne(@CurrentUser() user: RequestUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.suppliers.getById(user.tenantId, id);
  }

  @RequirePermission("suppliers.manage")
  @Patch(":id")
  update(
    @CurrentUser() user: RequestUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateSupplierDto,
  ) {
    return this.suppliers.update(user.tenantId, user.userId, id, dto);
  }
}
