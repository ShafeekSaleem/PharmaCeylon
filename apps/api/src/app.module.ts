import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";
import { AdminModule } from "./admin/admin.module";
import { AnalyticsModule } from "./analytics/analytics.module";
import { AuditModule } from "./audit/audit.module";
import { AuthModule } from "./auth/auth.module";
import { CatalogModule } from "./catalog/catalog.module";
import { HealthController } from "./health/health.controller";
import { InventoryModule } from "./inventory/inventory.module";
import { ProductsModule } from "./products/products.module";
import { PricingModule } from "./pricing/pricing.module";
import { PrismaModule } from "./prisma/prisma.module";
import { PurchasingModule } from "./purchasing/purchasing.module";
import { ReportsModule } from "./reports/reports.module";
import { SalesModule } from "./sales/sales.module";
import { CsrfGuard } from "./security/guards/csrf.guard";
import { JwtAuthGuard } from "./security/guards/jwt-auth.guard";
import { RolesGuard } from "./security/guards/roles.guard";
import { TenantBranchGuard } from "./security/guards/tenant-branch.guard";
import { SuppliersModule } from "./suppliers/suppliers.module";
import { TenantModule } from "./tenant/tenant.module";
import { TransfersModule } from "./transfers/transfers.module";
import { UploadsModule } from "./uploads/uploads.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ThrottlerModule.forRoot({
      throttlers: [{ name: "default", ttl: 60_000, limit: 120 }],
    }),
    PrismaModule,
    PricingModule,
    AuditModule,
    AuthModule,
    TenantModule,
    ProductsModule,
    SuppliersModule,
    AdminModule,
    PurchasingModule,
    InventoryModule,
    SalesModule,
    TransfersModule,
    ReportsModule,
    CatalogModule,
    AnalyticsModule,
    UploadsModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: TenantBranchGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
