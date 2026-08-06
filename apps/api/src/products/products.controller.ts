import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  StreamableFile,
} from "@nestjs/common";
import { RoleName } from "@prisma/client";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { Roles } from "../security/decorators/roles.decorator";
import {
  AuthenticatedRequest,
  RequestUser,
} from "../security/interfaces/authenticated-request.interface";
import { CreateProductDto } from "./dto/create-product.dto";
import { UpdateProductDto } from "./dto/update-product.dto";
import { ProductsService } from "./products.service";

@Controller("products")
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Roles(
    RoleName.owner,
    RoleName.manager,
    RoleName.pharmacist,
    RoleName.cashier,
    RoleName.inventory_clerk,
    RoleName.analyst,
  )
  @Get()
  list(
    @CurrentUser() user: RequestUser,
    @Req() req: AuthenticatedRequest,
    @Query("q") q?: string,
    @Query("skip") skip?: string,
    @Query("take") take?: string,
    @Query("dosageForm") dosageForm?: string,
    @Query("brandName") brandName?: string,
    @Query("schedule") schedule?: string,
    @Query("isControlled") isControlled?: string,
    @Query("requiresPrescription") requiresPrescription?: string,
    @Query("status") status?: string,
    @Query("lowStock") lowStock?: string,
    @Query("categoryId") categoryId?: string,
    @Query("tagId") tagId?: string,
    @Query("sortBy") sortBy?: string,
    @Query("sortDir") sortDir?: string,
  ) {
    return this.products.list(user.tenantId, req.branchId, {
      q,
      skip: skip ? Number(skip) : undefined,
      take: take ? Number(take) : undefined,
      dosageForm,
      brandName,
      schedule,
      isControlled,
      requiresPrescription: requiresPrescription === "true",
      status: status || "all",
      lowStock: lowStock === "true",
      categoryId,
      tagId,
      sortBy,
      sortDir,
    });
  }

  /** Full CSV for all products matching current list filters/sort. Must stay before `:id`. */
  @Roles(
    RoleName.owner,
    RoleName.manager,
    RoleName.pharmacist,
    RoleName.cashier,
    RoleName.inventory_clerk,
    RoleName.analyst,
  )
  @Get("export")
  async exportCsv(
    @CurrentUser() user: RequestUser,
    @Req() req: AuthenticatedRequest,
    @Query("q") q?: string,
    @Query("dosageForm") dosageForm?: string,
    @Query("brandName") brandName?: string,
    @Query("schedule") schedule?: string,
    @Query("isControlled") isControlled?: string,
    @Query("requiresPrescription") requiresPrescription?: string,
    @Query("status") status?: string,
    @Query("lowStock") lowStock?: string,
    @Query("categoryId") categoryId?: string,
    @Query("tagId") tagId?: string,
    @Query("sortBy") sortBy?: string,
    @Query("sortDir") sortDir?: string,
  ): Promise<StreamableFile> {
    const csv = await this.products.exportCsv(user.tenantId, req.branchId, {
      q,
      dosageForm,
      brandName,
      schedule,
      isControlled,
      requiresPrescription: requiresPrescription === "true",
      status: status || "all",
      lowStock: lowStock === "true",
      categoryId,
      tagId,
      sortBy,
      sortDir,
    });
    return new StreamableFile(Buffer.from(csv, "utf-8"), {
      type: "text/csv; charset=utf-8",
      disposition: 'attachment; filename="products-export.csv"',
    });
  }

  @Roles(
    RoleName.owner,
    RoleName.manager,
    RoleName.pharmacist,
    RoleName.cashier,
    RoleName.inventory_clerk,
    RoleName.analyst,
  )
  @Get(":id/detail")
  detail(
    @CurrentUser() user: RequestUser,
    @Req() req: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.products.getDetail(user.tenantId, req.branchId, id);
  }

  @Roles(
    RoleName.owner,
    RoleName.manager,
    RoleName.pharmacist,
    RoleName.cashier,
    RoleName.inventory_clerk,
    RoleName.analyst,
  )
  @Get(":id")
  getOne(@CurrentUser() user: RequestUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.products.getById(user.tenantId, id);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Post()
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateProductDto) {
    return this.products.create(user.tenantId, user.userId, dto);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Patch(":id")
  update(
    @CurrentUser() user: RequestUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.products.update(user.tenantId, user.userId, id, dto);
  }

  @Roles(RoleName.owner, RoleName.manager)
  @Delete(":id")
  remove(@CurrentUser() user: RequestUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.products.remove(user.tenantId, user.userId, id);
  }
}
