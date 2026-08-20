import { Controller, Get, Param, ParseUUIDPipe, Query, Req } from "@nestjs/common";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import {
  AuthenticatedRequest,
  RequestUser,
} from "../security/interfaces/authenticated-request.interface";
import { CatalogService } from "./catalog.service";

@Controller("catalog")
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @RequirePermission("catalog.view")
  @Get("search")
  search(
    @CurrentUser() user: RequestUser,
    @Req() req: AuthenticatedRequest,
    @Query("q") q?: string,
    @Query("skip") skip?: string,
    @Query("take") take?: string,
    @Query("dosageForm") dosageForm?: string,
    @Query("brandName") brandName?: string,
    @Query("schedule") schedule?: string,
    @Query("isControlled") isControlled?: string,
    @Query("categoryId") categoryId?: string,
    @Query("commercialCategoryId") commercialCategoryId?: string,
    @Query("tagId") tagId?: string,
    @Query("lowStock") lowStock?: string,
    @Query("inStock") inStock?: string,
    @Query("outOfStock") outOfStock?: string,
    @Query("exact") exact?: string,
    @Query("matchType") matchType?: string,
  ) {
    const skipN = skip != null && skip !== "" ? Number(skip) : 0;
    const takeN = take != null && take !== "" ? Number(take) : 40;
    const match =
      matchType === "exact" ||
      matchType === "generic" ||
      matchType === "alias" ||
      matchType === "partial"
        ? matchType
        : "all";
    return this.catalog.search(
      user.tenantId,
      req.branchId,
      {
        q,
        dosageForm,
        brandName,
        schedule,
        isControlled,
        categoryId,
        commercialCategoryId,
        tagId,
        lowStock: lowStock === "true",
        inStock: inStock === "true",
        outOfStock: outOfStock === "true",
        exact: exact === "true",
        status: "active",
        matchType: match,
      },
      Number.isFinite(skipN) ? skipN : 0,
      Number.isFinite(takeN) ? takeN : 40,
    );
  }

  @RequirePermission("catalog.view")
  @Get("facets")
  facets(
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
    @Query("commercialCategoryId") commercialCategoryId?: string,
    @Query("tagId") tagId?: string,
  ) {
    return this.catalog.facets(user.tenantId, req.branchId, {
      q,
      dosageForm,
      brandName,
      schedule,
      isControlled,
      requiresPrescription: requiresPrescription === "true",
      status: status || "active",
      lowStock: lowStock === "true",
      categoryId,
      commercialCategoryId,
      tagId,
    });
  }

  @RequirePermission("catalog.view")
  @Get("products/:productId")
  productDetail(
    @CurrentUser() user: RequestUser,
    @Req() req: AuthenticatedRequest,
    @Param("productId", ParseUUIDPipe) productId: string,
  ) {
    return this.catalog.productDetail(user.tenantId, req.branchId, productId);
  }

  @RequirePermission("catalog.view")
  @Get("products/:productId/alternatives")
  alternatives(
    @CurrentUser() user: RequestUser,
    @Req() req: AuthenticatedRequest,
    @Param("productId", ParseUUIDPipe) productId: string,
  ) {
    return this.catalog.alternatives(user.tenantId, req.branchId, productId);
  }
}
