import { Controller, Get, Query } from "@nestjs/common";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { PrismaService } from "../prisma/prisma.service";
import { CRITICAL_AUDIT_EVENT_NAMES } from "./audit-taxonomy";

@Controller("audit/summary")
export class AuditSummaryController {
  constructor(private readonly prisma: PrismaService) {}

  @RequirePermission("audit.view")
  @Get()
  async summary(@CurrentUser() user: RequestUser, @Query("branchId") branchId?: string) {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const baseWhere = {
      tenantId: user.tenantId,
      ...(branchId ? { branchId } : {}),
      createdAt: { gte: startOfDay },
    };

    const [eventsToday, criticalActions, failedLogins, actorRows] = await Promise.all([
      this.prisma.auditEvent.count({ where: baseWhere }),
      this.prisma.auditEvent.count({
        where: { ...baseWhere, eventName: { in: Array.from(CRITICAL_AUDIT_EVENT_NAMES) } },
      }),
      this.prisma.auditEvent.count({ where: { ...baseWhere, eventName: "auth.login_failed" } }),
      this.prisma.auditEvent.findMany({
        where: { ...baseWhere, actorUserId: { not: null } },
        distinct: ["actorUserId"],
        select: { actorUserId: true },
      }),
    ]);

    return {
      eventsToday,
      activeActors: actorRows.length,
      criticalActions,
      failedLogins,
    };
  }
}
