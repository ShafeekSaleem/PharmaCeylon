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
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { CustomersService } from "./customers.service";
import { CreateCustomerDto } from "./dto/create-customer.dto";
import { UpdateCustomerDto } from "./dto/update-customer.dto";

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

  @ApiOperation({
    summary: "Paginated customer directory for the Customers page",
    description:
      "Unlike the search endpoint, includes deactivated records and returns a total count.",
  })
  @RequirePermission("customers.view")
  @Get("directory")
  list(
    @CurrentUser() user: RequestUser,
    @Query("q") q?: string,
    @Query("status") status?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    return this.customers.list(user.tenantId, {
      q,
      status,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @ApiOperation({
    summary: "Customer profile with purchase and prescription history",
  })
  @RequirePermission("customers.view")
  @Get(":id/profile")
  getProfile(
    @CurrentUser() user: RequestUser,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.customers.getProfile(user.tenantId, id);
  }

  @RequirePermission("customers.view")
  @Get(":id")
  getOne(@CurrentUser() user: RequestUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.customers.getOne(user.tenantId, id);
  }

  @ApiOperation({ summary: "Correct customer details or deactivate the record" })
  @RequirePermission("customers.manage")
  @Patch(":id")
  update(
    @CurrentUser() user: RequestUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomerDto,
  ) {
    return this.customers.update(user.tenantId, id, dto);
  }

  @ApiOperation({ summary: "Register a customer from the counter" })
  @RequirePermission("customers.create")
  @Post()
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateCustomerDto) {
    return this.customers.create(user.tenantId, dto);
  }
}
