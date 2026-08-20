import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { CustomersService } from "./customers.service";
import { CreateCustomerDto } from "./dto/create-customer.dto";

@ApiTags("customers")
@Controller("customers")
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @ApiOperation({ summary: "Search customers by name, phone, or email" })
  @RequirePermission("customers.view")
  @Get()
  search(
    @CurrentUser() user: RequestUser,
    @Query("q") q?: string,
    @Query("take") take?: string,
  ) {
    return this.customers.search(user.tenantId, q, take ? Number(take) : undefined);
  }

  @RequirePermission("customers.view")
  @Get(":id")
  getOne(@CurrentUser() user: RequestUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.customers.getOne(user.tenantId, id);
  }

  @ApiOperation({ summary: "Register a customer from the counter" })
  @RequirePermission("customers.create")
  @Post()
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateCustomerDto) {
    return this.customers.create(user.tenantId, dto);
  }
}
