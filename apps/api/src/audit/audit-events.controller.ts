import { Controller, Get, Query } from "@nestjs/common";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { PrismaService } from "../prisma/prisma.service";

@Controller("audit/events")
export class AuditEventsController {
  constructor(private readonly prisma: PrismaService) {}

  @RequirePermission("audit.view")
  @Get()
  list(
    @CurrentUser() user: RequestUser,
    @Query("take") take?: string,
    @Query("branchId") branchId?: string,
    @Query("entityName") entityName?: string,
    @Query("entityId") entityId?: string,
  ) {
    const n = Math.min(take ? Number(take) : 100, 500);
    return this.prisma.auditEvent.findMany({
      where: {
        tenantId: user.tenantId,
        ...(branchId ? { branchId } : {}),
        ...(entityName ? { entityName } : {}),
        ...(entityId ? { entityId } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: n,
      include: {
        actor: { select: { id: true, fullName: true, email: true } },
      },
    });
  }
}
