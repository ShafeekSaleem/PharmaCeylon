import { Module } from "@nestjs/common";
import { SupplierLedgerController } from "./ledger/supplier-ledger.controller";
import { SupplierLedgerService } from "./ledger/supplier-ledger.service";
import { PurchasingController } from "./purchasing.controller";
import { PurchasingService } from "./purchasing.service";

@Module({
  // The ledger's routes are more specific (`invoices/unbilled-deliveries` before `invoices/:id`),
  // and live under the same `purchasing` prefix, so its controller is registered first.
  controllers: [SupplierLedgerController, PurchasingController],
  providers: [PurchasingService, SupplierLedgerService],
  exports: [PurchasingService, SupplierLedgerService],
})
export class PurchasingModule {}
