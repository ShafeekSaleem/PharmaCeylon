import { OperationalAuthorizationModule } from "../security/operational-authorization.module";
import { SupplierPaymentEvidenceModule } from "./ledger/supplier-payment-evidence.module";
import { EvidencedPaymentRecordingService } from "./ledger/evidenced-payment-recording.service";
import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { HeldDeliveryService } from "./held-delivery.service";
import { PreparedReceiptService } from "./prepared-receipt.service";
import { SupplierLedgerController } from "./ledger/supplier-ledger.controller";
import { SupplierLedgerService } from "./ledger/supplier-ledger.service";
import { PurchasingController } from "./purchasing.controller";
import { PurchasingService } from "./purchasing.service";

@Module({
  imports: [
    NotificationsModule,
    OperationalAuthorizationModule,
    SupplierPaymentEvidenceModule,
  ],
  // The ledger's routes are more specific (`invoices/unbilled-deliveries` before `invoices/:id`),
  // and live under the same `purchasing` prefix, so its controller is registered first.
  controllers: [SupplierLedgerController, PurchasingController],
  providers: [
    PurchasingService,
    SupplierLedgerService,
    HeldDeliveryService,
    PreparedReceiptService,
    EvidencedPaymentRecordingService,
  ],
  exports: [
    PurchasingService,
    SupplierLedgerService,
    HeldDeliveryService,
    PreparedReceiptService,
  ],
})
export class PurchasingModule {}
