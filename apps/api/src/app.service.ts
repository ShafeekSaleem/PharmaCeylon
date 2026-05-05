import { Injectable } from "@nestjs/common";
import { APP_NAME, HealthStatus } from "@pharmaceylon/shared";

@Injectable()
export class AppService {
  getHealth(): HealthStatus {
    return {
      ok: true,
      service: `${APP_NAME}-api`,
      timestamp: new Date().toISOString(),
    };
  }
}
