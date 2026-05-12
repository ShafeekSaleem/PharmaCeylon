import { Controller, Get, Query } from "@nestjs/common";
import { RoleName } from "@prisma/client";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { Roles } from "../security/decorators/roles.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { PrismaService } from "../prisma/prisma.service";

@Controller("audit/events")
export class AuditEventsController {
  constructor(private readonly prisma: PrismaService) {}

  @Roles(RoleName.owner, RoleName.manager, RoleName.analyst)
  @Get()
  list(
    @CurrentUser() user: RequestUser,
    @Query("take") take?: string,
    @Query("branchId") branchId?: string,
  ) {
    const n = Math.min(take ? Number(take) : 100, 500);
    return this.prisma.auditEvent.findMany({
      where: {
        tenantId: user.tenantId,
        ...(branchId ? { branchId } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: n,
    });
  }
}
