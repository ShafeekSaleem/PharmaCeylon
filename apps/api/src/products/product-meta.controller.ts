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
} from "@nestjs/common";
import { CategoryDimension } from "@prisma/client";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import {
  CreateProductAliasDto,
  CreateProductCategoryDto,
  CreateProductTagDto,
  MoveProductsCategoryDto,
  OnboardingSelectionDto,
  ReorderCategoriesDto,
  UpdateProductCategoryDto,
  UpdateProductTagDto,
} from "./dto/product-relations.dto";
import { ProductMetaService } from "./product-meta.service";

const READABLE_DIMENSIONS: CategoryDimension[] = [
  "COMMERCIAL",
  "DOSAGE_FORM",
  "NMRA_SCHEDULE",
  "REGISTRATION_TYPE",
];

@Controller("products")
export class ProductMetaController {
  constructor(private readonly meta: ProductMetaService) {}

  /**
   * Defaults to COMMERCIAL — Dosage Form/Schedule/Registration Type are read-only
   * classification facets, only surfaced here (not editable) when a caller explicitly asks
   * for them via `?dimension=`.
   */
  @RequirePermission("product_meta.view")
  @Get("categories")
  listCategories(
    @CurrentUser() user: RequestUser,
    @Query("dimension") dimension?: string,
  ) {
    const dim = READABLE_DIMENSIONS.includes(dimension as CategoryDimension)
      ? (dimension as CategoryDimension)
      : "COMMERCIAL";
    return this.meta.listCategories(user.tenantId, dim);
  }

  /** Settings → Catalog → Categories: full COMMERCIAL Department → Category tree. */
  @RequirePermission("product_meta.view")
  @Get("commercial-categories/tree")
  listCommercialTree(@CurrentUser() user: RequestUser) {
    return this.meta.listCommercialTree(user.tenantId);
  }

  @RequirePermission("product_meta.manage")
  @Post("commercial-categories/reorder")
  reorderCategories(@CurrentUser() user: RequestUser, @Body() dto: ReorderCategoriesDto) {
    return this.meta.reorderCategories(user.tenantId, dto);
  }

  @RequirePermission("product_meta.manage")
  @Post("commercial-categories/move-products")
  moveProductsCategory(@CurrentUser() user: RequestUser, @Body() dto: MoveProductsCategoryDto) {
    return this.meta.moveProductsCategory(user.tenantId, dto);
  }

  /** Onboarding "what does your pharmacy sell" — current department enablement. */
  @RequirePermission("product_meta.view")
  @Get("commercial-categories/onboarding")
  onboardingStatus(@CurrentUser() user: RequestUser) {
    return this.meta.onboardingStatus(user.tenantId);
  }

  @RequirePermission("product_meta.manage")
  @Post("commercial-categories/onboarding")
  applyOnboarding(@CurrentUser() user: RequestUser, @Body() dto: OnboardingSelectionDto) {
    return this.meta.applyOnboardingSelection(user.tenantId, dto.departments);
  }

  @RequirePermission("product_meta.manage")
  @Post("categories")
  createCategory(@CurrentUser() user: RequestUser, @Body() dto: CreateProductCategoryDto) {
    return this.meta.createCategory(user.tenantId, dto);
  }

  @RequirePermission("product_meta.manage")
  @Patch("categories/:id")
  updateCategory(
    @CurrentUser() user: RequestUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductCategoryDto,
  ) {
    return this.meta.updateCategory(user.tenantId, id, dto);
  }

  @RequirePermission("product_meta.delete")
  @Delete("categories/:id")
  deleteCategory(@CurrentUser() user: RequestUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.meta.deleteCategory(user.tenantId, id);
  }

  @RequirePermission("product_meta.view")
  @Get("tags")
  listTags(@CurrentUser() user: RequestUser) {
    return this.meta.listTags(user.tenantId);
  }

  @RequirePermission("product_meta.view")
  @Get("aliases")
  listAllAliases(@CurrentUser() user: RequestUser) {
    return this.meta.listAllAliases(user.tenantId);
  }

  @RequirePermission("product_meta.manage")
  @Post("tags")
  createTag(@CurrentUser() user: RequestUser, @Body() dto: CreateProductTagDto) {
    return this.meta.createTag(user.tenantId, dto);
  }

  @RequirePermission("product_meta.manage")
  @Patch("tags/:id")
  updateTag(
    @CurrentUser() user: RequestUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductTagDto,
  ) {
    return this.meta.updateTag(user.tenantId, id, dto);
  }

  @RequirePermission("product_meta.delete")
  @Delete("tags/:id")
  deleteTag(@CurrentUser() user: RequestUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.meta.deleteTag(user.tenantId, id);
  }

  @RequirePermission("product_meta.view")
  @Get(":productId/aliases")
  listAliases(
    @CurrentUser() user: RequestUser,
    @Param("productId", ParseUUIDPipe) productId: string,
  ) {
    return this.meta.listAliases(user.tenantId, productId);
  }

  @RequirePermission("product_meta.manage")
  @Post(":productId/aliases")
  addAlias(
    @CurrentUser() user: RequestUser,
    @Param("productId", ParseUUIDPipe) productId: string,
    @Body() dto: CreateProductAliasDto,
  ) {
    return this.meta.addAlias(user.tenantId, productId, dto);
  }

  @RequirePermission("product_meta.manage")
  @Delete(":productId/aliases/:aliasId")
  removeAlias(
    @CurrentUser() user: RequestUser,
    @Param("productId", ParseUUIDPipe) productId: string,
    @Param("aliasId", ParseUUIDPipe) aliasId: string,
  ) {
    return this.meta.removeAlias(user.tenantId, productId, aliasId);
  }
}
