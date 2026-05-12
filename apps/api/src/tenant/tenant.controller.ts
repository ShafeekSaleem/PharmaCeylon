import { Controller, Get } from "@nestjs/common";
import { RoleName } from "@prisma/client";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { Roles } from "../security/decorators/roles.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { PrismaService } from "../prisma/prisma.service";

@Controller("tenant")
export class TenantController {
  constructor(private readonly prisma: PrismaService) {}

  @Get("context")
  async getContext(@CurrentUser() user: RequestUser) {
    const branches = await this.prisma.branch.findMany({
      where: {
        tenantId: user.tenantId,
        isActive: true,
        id: { in: user.branchRoles.map((b) => b.branchId) },
      },
      select: { id: true, code: true, name: true, city: true },
      orderBy: { code: "asc" },
    });
    const branchById = new Map(branches.map((b) => [b.id, b]));
    return {
      tenantId: user.tenantId,
      userId: user.userId,
      branchRoles: user.branchRoles.map((br) => ({
        ...br,
        branch: branchById.get(br.branchId) ?? { id: br.branchId },
      })),
    };
  }

  @Roles(
    RoleName.owner,
    RoleName.manager,
    RoleName.pharmacist,
    RoleName.cashier,
    RoleName.inventory_clerk,
    RoleName.analyst,
  )
  @Get("branches")
  listBranches(@CurrentUser() user: RequestUser) {
    return this.prisma.branch.findMany({
      where: {
        tenantId: user.tenantId,
        isActive: true,
        id: { in: user.branchRoles.map((b) => b.branchId) },
      },
      select: { id: true, code: true, name: true, city: true, timezone: true },
      orderBy: { code: "asc" },
    });
  }

  @Roles(RoleName.manager, RoleName.owner)
  @Get("management")
  managementOnly() {
    return { ok: true };
  }
}
