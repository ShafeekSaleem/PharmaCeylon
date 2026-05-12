import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { APP_NAME, HealthStatus } from "@pharmaceylon/shared";
import { PrismaService } from "../prisma/prisma.service";
import { Public } from "../security/decorators/public.decorator";

@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get("health")
  getHealth(): HealthStatus {
    return {
      ok: true,
      service: `${APP_NAME}-api`,
      timestamp: new Date().toISOString(),
    };
  }

  /** Readiness: verifies database connectivity (for orchestrators / load balancers). */
  @Public()
  @Get("health/ready")
  async getReadiness(): Promise<{ ok: boolean; database: boolean; timestamp: string }> {
    try {
      await this.prisma.$queryRawUnsafe("SELECT 1");
      return {
        ok: true,
        database: true,
        timestamp: new Date().toISOString(),
      };
    } catch {
      throw new ServiceUnavailableException({
        ok: false,
        database: false,
        timestamp: new Date().toISOString(),
      });
    }
  }
}
