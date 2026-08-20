import { Global, Module } from "@nestjs/common";
import { PermissionsService } from "./permissions.service";

/**
 * Global so any feature module (e.g. the roles/permissions admin endpoints)
 * can inject `PermissionsService` without importing this module directly —
 * same pattern as `PrismaModule`.
 */
@Global()
@Module({
  providers: [PermissionsService],
  exports: [PermissionsService],
})
export class SecurityModule {}
