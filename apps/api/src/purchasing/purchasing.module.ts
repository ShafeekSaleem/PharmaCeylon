import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { HeldDeliveryService } from "./held-delivery.service";
import { SupplierLedgerController } from "./ledger/supplier-ledger.controller";
import { SupplierLedgerService } from "./ledger/supplier-ledger.service";
import { PurchasingController } from "./purchasing.controller";
import { PurchasingService } from "./purchasing.service";

@Module({
  imports: [NotificationsModule],
  // The ledger's routes are more specific (`invoices/unbilled-deliveries` before `invoices/:id`),
  // and live under the same `purchasing` prefix, so its controller is registered first.
  controllers: [SupplierLedgerController, PurchasingController],
  providers: [PurchasingService, SupplierLedgerService, HeldDeliveryService],
  exports: [PurchasingService, SupplierLedgerService],
})
export class PurchasingModule {}
