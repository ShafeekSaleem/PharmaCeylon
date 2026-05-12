import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";
import { AuthModule } from "./auth/auth.module";
import { HealthController } from "./health/health.controller";
import { PrismaModule } from "./prisma/prisma.module";
import { CsrfGuard } from "./security/guards/csrf.guard";
import { JwtAuthGuard } from "./security/guards/jwt-auth.guard";
import { RolesGuard } from "./security/guards/roles.guard";
import { TenantBranchGuard } from "./security/guards/tenant-branch.guard";
import { TenantController } from "./tenant/tenant.controller";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ThrottlerModule.forRoot({
      throttlers: [{ name: "default", ttl: 60_000, limit: 120 }],
    }),
    PrismaModule,
    AuthModule,
  ],
  controllers: [HealthController, TenantController],
  providers: [
    // Order matters — guards run top-to-bottom.
    //   JWT (authenticate)
    //   → CSRF (block cross-origin POST/PUT/PATCH/DELETE for cookie auth)
    //   → TenantBranch (scope by branch header)
    //   → Roles (RBAC)
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: TenantBranchGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
