import { Module } from "@nestjs/common";
import { SupplierPaymentEvidenceService } from "./supplier-payment-evidence.service";
import { SupplierPaymentEvidenceController } from "./supplier-payment-evidence.controller";

@Module({
  providers: [SupplierPaymentEvidenceService],
  controllers: [SupplierPaymentEvidenceController],
  exports: [SupplierPaymentEvidenceService],
})
export class SupplierPaymentEvidenceModule {}
