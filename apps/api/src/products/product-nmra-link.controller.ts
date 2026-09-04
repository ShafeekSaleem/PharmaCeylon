import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { NmraBulkLinkDto, NmraLinkDto } from "./dto/nmra-link.dto";
import { ProductNmraLinkService } from "./product-nmra-link.service";

@Controller("products")
export class ProductNmraLinkController {
  constructor(private readonly nmraLink: ProductNmraLinkService) {}

  /**
   * The bulk review queue. Must stay ahead of `:id/nmra-link/...` below only in the sense
   * that both are distinct multi-segment paths — Nest/Express match `:id` against exactly one
   * segment, so "nmra-link" here never collides with a product id the way `organize` did.
   */
  @RequirePermission("products.view")
  @Get("nmra-link/unlinked")
  unlinkedQueue(
    @CurrentUser() user: RequestUser,
    @Query("skip") skip?: string,
    @Query("take") take?: string,
  ) {
    return this.nmraLink.unlinkedQueue(
      user.tenantId,
      skip ? Number(skip) : undefined,
      take ? Number(take) : undefined,
    );
  }

  @RequirePermission("products.manage")
  @Post("nmra-link/bulk")
  bulkLink(@CurrentUser() user: RequestUser, @Body() dto: NmraBulkLinkDto) {
    return this.nmraLink.bulkLink(user.tenantId, user.userId, dto.links);
  }

  @RequirePermission("products.view")
  @Get(":id/nmra-link/candidates")
  candidates(
    @CurrentUser() user: RequestUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Query("take") take?: string,
  ) {
    return this.nmraLink.candidates(user.tenantId, id, take ? Number(take) : undefined);
  }

  @RequirePermission("products.manage")
  @Post(":id/nmra-link/preview")
  preview(
    @CurrentUser() user: RequestUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: NmraLinkDto,
  ) {
    return this.nmraLink.preview(user.tenantId, id, dto.referenceProductId, {
      adoptFieldOverrides: dto.adoptFieldOverrides,
    });
  }

  @RequirePermission("products.manage")
  @Post(":id/nmra-link")
  link(
    @CurrentUser() user: RequestUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: NmraLinkDto,
  ) {
    return this.nmraLink.link(user.tenantId, user.userId, id, dto.referenceProductId, {
      adoptFieldOverrides: dto.adoptFieldOverrides,
    });
  }

  @RequirePermission("products.manage")
  @Delete(":id/nmra-link")
  unlink(@CurrentUser() user: RequestUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.nmraLink.unlink(user.tenantId, user.userId, id);
  }
}
