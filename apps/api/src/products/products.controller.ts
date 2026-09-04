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
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import {
  AuthenticatedRequest,
  RequestUser,
} from "../security/interfaces/authenticated-request.interface";
import { BulkProductsDto } from "./dto/bulk-products.dto";
import { CreateProductDto } from "./dto/create-product.dto";
import { UpdateProductDto } from "./dto/update-product.dto";
import { ProductOrganizeService } from "./product-organize.service";
import { ProductsService } from "./products.service";

@Controller("products")
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly organize: ProductOrganizeService,
  ) {}

  @RequirePermission("products.view")
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
    @Query("rangeStatus") rangeStatus?: string,
    @Query("lowStock") lowStock?: string,
    @Query("categoryId") categoryId?: string,
    @Query("commercialCategoryId") commercialCategoryId?: string,
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
      rangeStatus: rangeStatus || "all",
      lowStock: lowStock === "true",
      categoryId,
      commercialCategoryId,
      tagId,
      sortBy,
      sortDir,
    });
  }

  /** Full CSV for all products matching current list filters/sort. Must stay before `:id`. */
  @RequirePermission("products.view")
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
    @Query("rangeStatus") rangeStatus?: string,
    @Query("lowStock") lowStock?: string,
    @Query("categoryId") categoryId?: string,
    @Query("commercialCategoryId") commercialCategoryId?: string,
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
      rangeStatus: rangeStatus || "all",
      lowStock: lowStock === "true",
      categoryId,
      commercialCategoryId,
      tagId,
      sortBy,
      sortDir,
    });
    return new StreamableFile(Buffer.from(csv, "utf-8"), {
      type: "text/csv; charset=utf-8",
      disposition: 'attachment; filename="products-export.csv"',
    });
  }

  /**
   * Catalog-organisation coverage: how much of the range is filed somewhere real. Must stay
   * ahead of the `:id` routes, or the path segment is parsed as a product id.
   */
  @RequirePermission("products.view")
  @Get("organize/coverage")
  coverage(@CurrentUser() user: RequestUser) {
    return this.organize.coverage(user.tenantId);
  }

  /** The worklist itself — ranged products with no real category, each with a suggestion. */
  @RequirePermission("products.view")
  @Get("organize/unplaced")
  unplaced(
    @CurrentUser() user: RequestUser,
    @Query("skip") skip?: string,
    @Query("take") take?: string,
  ) {
    return this.organize.unplaced(
      user.tenantId,
      skip ? Number(skip) : undefined,
      take ? Number(take) : undefined,
    );
  }

  /**
   * What a bulk action would do, so the confirmation dialog can state the change before it
   * happens rather than reporting it afterwards. Same body as `POST bulk`, no writes.
   */
  @RequirePermission("products.manage")
  @Post("bulk/preview")
  bulkPreview(@CurrentUser() user: RequestUser, @Body() dto: BulkProductsDto) {
    return this.products.bulkPreview(user.tenantId, dto);
  }

  /**
   * Range/un-range, activate/deactivate, or re-file the categories and tags of many products
   * in one call. Declared before the `:id` routes so the path segment is never parsed as a
   * product id.
   */
  @RequirePermission("products.manage")
  @Post("bulk")
  bulk(@CurrentUser() user: RequestUser, @Body() dto: BulkProductsDto) {
    return this.products.bulkUpdate(user.tenantId, user.userId, dto);
  }

  @RequirePermission("products.view")
  @Get(":id/detail")
  detail(
    @CurrentUser() user: RequestUser,
    @Req() req: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.products.getDetail(user.tenantId, req.branchId, id);
  }

  @RequirePermission("products.view")
  @Get(":id")
  getOne(@CurrentUser() user: RequestUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.products.getById(user.tenantId, id);
  }

  @RequirePermission("products.manage")
  @Post()
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateProductDto) {
    return this.products.create(user.tenantId, user.userId, dto);
  }

  @RequirePermission("products.manage")
  @Patch(":id")
  update(
    @CurrentUser() user: RequestUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.products.update(user.tenantId, user.userId, id, dto);
  }

  @RequirePermission("products.delete")
  @Delete(":id")
  remove(@CurrentUser() user: RequestUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.products.remove(user.tenantId, user.userId, id);
  }
}
