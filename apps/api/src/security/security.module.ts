import { Global, Module } from "@nestjs/common";
import { AccessService } from "./access.service";
import { PermissionsService } from "./permissions.service";

/**
 * Global so any feature module (e.g. the roles/permissions admin endpoints)
 * can inject `PermissionsService` and `AccessService` without importing this
 * module directly — same pattern as `PrismaModule`.
 */
@Global()
@Module({
  providers: [PermissionsService, AccessService],
  exports: [PermissionsService, AccessService],
})
export class SecurityModule {}
