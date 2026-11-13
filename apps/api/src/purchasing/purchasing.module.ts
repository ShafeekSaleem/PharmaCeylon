import { OperationalAuthorizationModule } from "../security/operational-authorization.module";
import { SupplierPaymentEvidenceModule } from "./ledger/supplier-payment-evidence.module";
import { EvidencedPaymentRecordingService } from "./ledger/evidenced-payment-recording.service";
import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { HeldDeliveryService } from "./held-delivery.service";
import { PreparedReceiptService } from "./prepared-receipt.service";
import { SupplierCashPayoutController } from "./ledger/supplier-cash-payout.controller";
import { SupplierCashPayoutService } from "./ledger/supplier-cash-payout.service";
import { SupplierLedgerController } from "./ledger/supplier-ledger.controller";
import { SupplierLedgerService } from "./ledger/supplier-ledger.service";
import { TerminalsModule } from "../terminals/terminals.module";
import { PurchasingController } from "./purchasing.controller";
import { PurchasingService } from "./purchasing.service";

@Module({
  imports: [
    NotificationsModule,
    OperationalAuthorizationModule,
    SupplierPaymentEvidenceModule,
    TerminalsModule,
  ],
  // The ledger's routes are more specific (`invoices/unbilled-deliveries` before `invoices/:id`),
  // and live under the same `purchasing` prefix, so its controller is registered first.
  controllers: [SupplierCashPayoutController, SupplierLedgerController, PurchasingController],
  providers: [
    PurchasingService,
    SupplierLedgerService,
    SupplierCashPayoutService,
    HeldDeliveryService,
    PreparedReceiptService,
    EvidencedPaymentRecordingService,
  ],
  exports: [
    PurchasingService,
    SupplierLedgerService,
    SupplierCashPayoutService,
    HeldDeliveryService,
    PreparedReceiptService,
  ],
})
export class PurchasingModule {}
