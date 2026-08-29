import { Controller, Get, Query } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { PrismaService } from "../prisma/prisma.service";
import { CRITICAL_AUDIT_EVENT_NAMES, eventNamePrefixesForModule, isCriticalAuditEvent } from "./audit-taxonomy";
import { resolveAuditEntityLabels } from "./audit-entity-labels";

@Controller("audit/events")
export class AuditEventsController {
  constructor(private readonly prisma: PrismaService) {}

  @RequirePermission("audit.view")
  @Get()
  async list(
    @CurrentUser() user: RequestUser,
    @Query("take") take?: string,
    @Query("skip") skip?: string,
    @Query("branchId") branchId?: string,
    @Query("entityName") entityName?: string,
    @Query("entityId") entityId?: string,
    @Query("module") moduleKey?: string,
    @Query("action") action?: string,
    @Query("actorUserId") actorUserId?: string,
    @Query("severity") severity?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("q") q?: string,
  ) {
    const takeN = Math.min(Math.max(take ? Number(take) : 25, 1), 100);
    const skipN = Math.max(skip ? Number(skip) : 0, 0);

    const and: Prisma.AuditEventWhereInput[] = [];

    const prefixes = moduleKey ? eventNamePrefixesForModule(moduleKey) : null;
    if (prefixes) {
      and.push({ OR: prefixes.map((p) => ({ eventName: { startsWith: `${p}.` } })) });
    }
    if (action) {
      and.push({ eventName: { contains: action, mode: "insensitive" } });
    }
    if (severity === "critical") {
      and.push({ eventName: { in: Array.from(CRITICAL_AUDIT_EVENT_NAMES) } });
    }
    if (q) {
      and.push({
        OR: [
          { eventName: { contains: q, mode: "insensitive" } },
          { entityName: { contains: q, mode: "insensitive" } },
          { actor: { fullName: { contains: q, mode: "insensitive" } } },
          { actor: { email: { contains: q, mode: "insensitive" } } },
        ],
      });
    }

    const where: Prisma.AuditEventWhereInput = {
      tenantId: user.tenantId,
      ...(branchId ? { branchId } : {}),
      ...(entityName ? { entityName } : {}),
      ...(entityId ? { entityId } : {}),
      ...(actorUserId ? { actorUserId } : {}),
      ...(from || to
        ? {
            createdAt: {
              ...(from ? { gte: new Date(from) } : {}),
              ...(to ? { lte: new Date(to) } : {}),
            },
          }
        : {}),
      ...(and.length ? { AND: and } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.auditEvent.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: skipN,
        take: takeN,
        include: {
          actor: { select: { id: true, fullName: true, email: true } },
          branch: { select: { id: true, name: true } },
        },
      }),
      this.prisma.auditEvent.count({ where }),
    ]);

    const labels = await resolveAuditEntityLabels(this.prisma, user.tenantId, items);

    return {
      items: items.map((e) => ({
        ...e,
        critical: isCriticalAuditEvent(e.eventName),
        entityLabel: labels.get(`${e.entityName}:${e.entityId}`) ?? null,
      })),
      total,
      take: takeN,
      skip: skipN,
    };
  }
}
