import { Controller, Get, Param, ParseUUIDPipe, Query, Req } from "@nestjs/common";
import { RoleName } from "@prisma/client";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { Roles } from "../security/decorators/roles.decorator";
import {
  AuthenticatedRequest,
  RequestUser,
} from "../security/interfaces/authenticated-request.interface";
import { CatalogService } from "./catalog.service";

const CATALOG_READ = [
  RoleName.owner,
  RoleName.manager,
  RoleName.pharmacist,
  RoleName.cashier,
  RoleName.inventory_clerk,
  RoleName.analyst,
] as const;

@Controller("catalog")
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Roles(...CATALOG_READ)
  @Get("search")
  search(
    @CurrentUser() user: RequestUser,
    @Req() req: AuthenticatedRequest,
    @Query("q") q?: string,
    @Query("skip") skip?: string,
    @Query("take") take?: string,
    @Query("dosageForm") dosageForm?: string,
    @Query("brandName") brandName?: string,
    @Query("isControlled") isControlled?: string,
    @Query("categoryId") categoryId?: string,
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
        isControlled,
        categoryId,
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

  @Roles(...CATALOG_READ)
  @Get("facets")
  facets(
    @CurrentUser() user: RequestUser,
    @Req() req: AuthenticatedRequest,
    @Query("q") q?: string,
    @Query("dosageForm") dosageForm?: string,
    @Query("brandName") brandName?: string,
    @Query("isControlled") isControlled?: string,
    @Query("status") status?: string,
    @Query("lowStock") lowStock?: string,
    @Query("categoryId") categoryId?: string,
    @Query("tagId") tagId?: string,
  ) {
    return this.catalog.facets(user.tenantId, req.branchId, {
      q,
      dosageForm,
      brandName,
      isControlled,
      status: status || "active",
      lowStock: lowStock === "true",
      categoryId,
      tagId,
    });
  }

  @Roles(...CATALOG_READ)
  @Get("products/:productId")
  productDetail(
    @CurrentUser() user: RequestUser,
    @Req() req: AuthenticatedRequest,
    @Param("productId", ParseUUIDPipe) productId: string,
  ) {
    return this.catalog.productDetail(user.tenantId, req.branchId, productId);
  }

  @Roles(...CATALOG_READ)
  @Get("products/:productId/alternatives")
  alternatives(
    @CurrentUser() user: RequestUser,
    @Req() req: AuthenticatedRequest,
    @Param("productId", ParseUUIDPipe) productId: string,
  ) {
    return this.catalog.alternatives(user.tenantId, req.branchId, productId);
  }
}
