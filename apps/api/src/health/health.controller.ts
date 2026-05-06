import { Controller, Get } from "@nestjs/common";
import { APP_NAME, HealthStatus } from "@pharmaceylon/shared";
import { Public } from "../security/decorators/public.decorator";

@Controller()
export class HealthController {
  @Public()
  @Get("health")
  getHealth(): HealthStatus {
    return {
      ok: true,
      service: `${APP_NAME}-api`,
      timestamp: new Date().toISOString(),
    };
  }
}
