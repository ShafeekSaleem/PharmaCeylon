import { Controller, Get, Param, ParseUUIDPipe, Query, Req } from "@nestjs/common";
import { RoleName } from "@prisma/client";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { Roles } from "../security/decorators/roles.decorator";
import {
  AuthenticatedRequest,
  RequestUser,
} from "../security/interfaces/authenticated-request.interface";
import { CatalogService } from "./catalog.service";

@Controller("catalog")
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Roles(
    RoleName.owner,
    RoleName.manager,
    RoleName.pharmacist,
    RoleName.cashier,
    RoleName.inventory_clerk,
    RoleName.analyst,
  )
  @Get("search")
  search(
    @CurrentUser() user: RequestUser,
    @Req() req: AuthenticatedRequest,
    @Query("q") q: string,
    @Query("skip") skip?: string,
    @Query("take") take?: string,
  ) {
    const branchId = req.branchId;
    return this.catalog.search(
      user.tenantId,
      branchId,
      q ?? "",
      skip ? Number(skip) : 0,
      take ? Number(take) : 20,
    );
  }

  @Roles(
    RoleName.owner,
    RoleName.manager,
    RoleName.pharmacist,
    RoleName.cashier,
    RoleName.inventory_clerk,
    RoleName.analyst,
  )
  @Get("facets")
  facets(@CurrentUser() user: RequestUser, @Req() req: AuthenticatedRequest, @Query("q") q?: string) {
    return this.catalog.facets(user.tenantId, req.branchId, q);
  }

  @Roles(
    RoleName.owner,
    RoleName.manager,
    RoleName.pharmacist,
    RoleName.cashier,
    RoleName.inventory_clerk,
    RoleName.analyst,
  )
  @Get("products/:productId/alternatives")
  alternatives(
    @CurrentUser() user: RequestUser,
    @Req() req: AuthenticatedRequest,
    @Param("productId", ParseUUIDPipe) productId: string,
  ) {
    return this.catalog.alternatives(user.tenantId, req.branchId, productId);
  }
}
