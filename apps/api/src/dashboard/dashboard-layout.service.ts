import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { SaveDashboardLayoutDto } from "./dto/save-dashboard-layout.dto";

@Injectable()
export class DashboardLayoutService {
  constructor(private readonly prisma: PrismaService) {}

  async getLayout(tenantId: string, userId: string) {
    const row = await this.prisma.dashboardLayout.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
      select: { widgets: true, updatedAt: true },
    });
    return row ? { widgets: row.widgets, updatedAt: row.updatedAt } : null;
  }

  async saveLayout(
    tenantId: string,
    userId: string,
    dto: SaveDashboardLayoutDto,
  ) {
    const widgets = dto.widgets as unknown as Prisma.InputJsonValue;
    const row = await this.prisma.dashboardLayout.upsert({
      where: { tenantId_userId: { tenantId, userId } },
      create: { tenantId, userId, widgets },
      update: { widgets },
      select: { widgets: true, updatedAt: true },
    });
    return row;
  }

  async resetLayout(tenantId: string, userId: string) {
    await this.prisma.dashboardLayout.deleteMany({ where: { tenantId, userId } });
    return { widgets: null };
  }
}
