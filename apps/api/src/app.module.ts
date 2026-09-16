import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";
import { AdminModule } from "./admin/admin.module";
import { AnalyticsModule } from "./analytics/analytics.module";
import { AuditModule } from "./audit/audit.module";
import { StockModule } from "./inventory/stock/stock.module";
import { AuthModule } from "./auth/auth.module";
import { CatalogModule } from "./catalog/catalog.module";
import { CatalogTaskModule } from "./catalog-tasks/catalog-task.module";
import { CustomersModule } from "./customers/customers.module";
import { DashboardModule } from "./dashboard/dashboard.module";
import { HealthController } from "./health/health.controller";
import { InventoryModule } from "./inventory/inventory.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { ProductImportModule } from "./product-import/product-import.module";
import { ProductsModule } from "./products/products.module";
import { PricingModule } from "./pricing/pricing.module";
import { PrismaModule } from "./prisma/prisma.module";
import { TenantTransactionInterceptor } from "./prisma/tenant-transaction.interceptor";
import { PurchasingModule } from "./purchasing/purchasing.module";
import { ReportsModule } from "./reports/reports.module";
import { ReturnsModule } from "./returns/returns.module";
import { SalesModule } from "./sales/sales.module";
import { SearchModule } from "./search/search.module";
import { CsrfGuard } from "./security/guards/csrf.guard";
import { JwtAuthGuard } from "./security/guards/jwt-auth.guard";
import { RolesGuard } from "./security/guards/roles.guard";
import { TenantBranchGuard } from "./security/guards/tenant-branch.guard";
import { SecurityModule } from "./security/security.module";
import { SuppliersModule } from "./suppliers/suppliers.module";
import { TenantModule } from "./tenant/tenant.module";
import { StocktakesModule } from "./stocktakes/stocktakes.module";
import { TransfersModule } from "./transfers/transfers.module";
import { UploadsModule } from "./uploads/uploads.module";
import { SetupModule } from "./setup/setup.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ThrottlerModule.forRoot({
      throttlers: [{ name: "default", ttl: 60_000, limit: 120 }],
    }),
    PrismaModule,
    SecurityModule,
    PricingModule,
    AuditModule,
    StockModule,
    AuthModule,
    TenantModule,
    ProductsModule,
    ProductImportModule,
    CatalogTaskModule,
    SuppliersModule,
    AdminModule,
    PurchasingModule,
    InventoryModule,
    NotificationsModule,
    CustomersModule,
    DashboardModule,
    SalesModule,
    SearchModule,
    TransfersModule,
    StocktakesModule,
    ReturnsModule,
    ReportsModule,
    CatalogModule,
    AnalyticsModule,
    UploadsModule,
    SetupModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: TenantBranchGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantTransactionInterceptor },
  ],
})
export class AppModule {}
