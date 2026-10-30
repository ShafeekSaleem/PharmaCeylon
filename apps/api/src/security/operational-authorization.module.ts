import { Module } from "@nestjs/common";
import { SupplierPaymentEvidenceModule } from "../purchasing/ledger/supplier-payment-evidence.module";
import { TerminalsModule } from "../terminals/terminals.module";
import { ManagementApprovalsService } from "./management-approvals.service";
import { OperationAuthorizationService } from "./operation-authorization.service";
import { MandatoryOperationEvidence } from "./mandatory-operation-evidence";

@Module({
  imports: [TerminalsModule, SupplierPaymentEvidenceModule],
  providers: [
    ManagementApprovalsService,
    OperationAuthorizationService,
    MandatoryOperationEvidence,
  ],
  exports: [
    ManagementApprovalsService,
    OperationAuthorizationService,
    MandatoryOperationEvidence,
  ],
})
export class OperationalAuthorizationModule {}
