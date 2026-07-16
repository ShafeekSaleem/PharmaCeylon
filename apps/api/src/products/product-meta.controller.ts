import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from "@nestjs/common";
import { RoleName } from "@prisma/client";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { Roles } from "../security/decorators/roles.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import {
  CreateProductAliasDto,
  CreateProductCategoryDto,
  CreateProductTagDto,
  UpdateProductCategoryDto,
  UpdateProductTagDto,
} from "./dto/product-relations.dto";
import { ProductMetaService } from "./product-meta.service";

@Controller("products")
export class ProductMetaController {
  constructor(private readonly meta: ProductMetaService) {}

  @Roles(
    RoleName.owner,
    RoleName.manager,
    RoleName.pharmacist,
    RoleName.cashier,
    RoleName.inventory_clerk,
    RoleName.analyst,
  )
  @Get("categories")
  listCategories(@CurrentUser() user: RequestUser) {
    return this.meta.listCategories(user.tenantId);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Post("categories")
  createCategory(@CurrentUser() user: RequestUser, @Body() dto: CreateProductCategoryDto) {
    return this.meta.createCategory(user.tenantId, dto);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Patch("categories/:id")
  updateCategory(
    @CurrentUser() user: RequestUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductCategoryDto,
  ) {
    return this.meta.updateCategory(user.tenantId, id, dto);
  }

  @Roles(RoleName.owner, RoleName.manager)
  @Delete("categories/:id")
  deleteCategory(@CurrentUser() user: RequestUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.meta.deleteCategory(user.tenantId, id);
  }

  @Roles(
    RoleName.owner,
    RoleName.manager,
    RoleName.pharmacist,
    RoleName.cashier,
    RoleName.inventory_clerk,
    RoleName.analyst,
  )
  @Get("tags")
  listTags(@CurrentUser() user: RequestUser) {
    return this.meta.listTags(user.tenantId);
  }

  @Roles(
    RoleName.owner,
    RoleName.manager,
    RoleName.pharmacist,
    RoleName.cashier,
    RoleName.inventory_clerk,
    RoleName.analyst,
  )
  @Get("aliases")
  listAllAliases(@CurrentUser() user: RequestUser) {
    return this.meta.listAllAliases(user.tenantId);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Post("tags")
  createTag(@CurrentUser() user: RequestUser, @Body() dto: CreateProductTagDto) {
    return this.meta.createTag(user.tenantId, dto);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Patch("tags/:id")
  updateTag(
    @CurrentUser() user: RequestUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductTagDto,
  ) {
    return this.meta.updateTag(user.tenantId, id, dto);
  }

  @Roles(RoleName.owner, RoleName.manager)
  @Delete("tags/:id")
  deleteTag(@CurrentUser() user: RequestUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.meta.deleteTag(user.tenantId, id);
  }

  @Roles(
    RoleName.owner,
    RoleName.manager,
    RoleName.pharmacist,
    RoleName.cashier,
    RoleName.inventory_clerk,
    RoleName.analyst,
  )
  @Get(":productId/aliases")
  listAliases(
    @CurrentUser() user: RequestUser,
    @Param("productId", ParseUUIDPipe) productId: string,
  ) {
    return this.meta.listAliases(user.tenantId, productId);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Post(":productId/aliases")
  addAlias(
    @CurrentUser() user: RequestUser,
    @Param("productId", ParseUUIDPipe) productId: string,
    @Body() dto: CreateProductAliasDto,
  ) {
    return this.meta.addAlias(user.tenantId, productId, dto);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Delete(":productId/aliases/:aliasId")
  removeAlias(
    @CurrentUser() user: RequestUser,
    @Param("productId", ParseUUIDPipe) productId: string,
    @Param("aliasId", ParseUUIDPipe) aliasId: string,
  ) {
    return this.meta.removeAlias(user.tenantId, productId, aliasId);
  }
}
