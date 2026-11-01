import { Injectable, Optional } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { OnlineTerminalCommand } from "@pharmaceylon/shared";
import { denied } from "../terminals/terminal-wire";
import { OperatingHoursEvidence } from "../terminals/operating-hours.evidence";
import { SupplierPaymentEvidenceService } from "../purchasing/ledger/supplier-payment-evidence.service";
import { type ClinicalEvidence, PharmacistRegistrationService } from "../clinical/pharmacist-registration.service";

/** Integration ports for server-resolved evidence. No owner/manager shortcut and no
 * caller-supplied verified booleans. Real domain providers must bind the exact command,
 * staff, branch, amount/products and applicable mandatory restrictions.
 */
@Injectable()
export class MandatoryOperationEvidence {
  /** The application module installs the real branch-hours (P1 MR 7) and pharmacist-registration
   * providers. Without one — a bare instance in a test or script — that port keeps failing closed. */
  constructor(
    @Optional() private readonly hoursProvider?: OperatingHoursEvidence,
    @Optional()
    private readonly paymentProvider?: SupplierPaymentEvidenceService,
    @Optional()
    private readonly clinicalProvider?: PharmacistRegistrationService,
  ) {}

  /** The signed session's staff member must hold a current SLMC registration an owner recorded
   * (P1 #47); no role, permission or ownership substitutes for it. Returns the registration
   * relied on, for the operation's provenance. */
  async clinical(
    tx: Prisma.TransactionClient,
    command: OnlineTerminalCommand<unknown>,
  ): Promise<ClinicalEvidence> {
    if (!this.clinicalProvider) denied("PHARMACIST_REQUIRED");
    return this.clinicalProvider.assertForCommand(tx, command);
  }
  async hours(
    tx: Prisma.TransactionClient,
    command: OnlineTerminalCommand<unknown>,
  ): Promise<void> {
    if (!this.hoursProvider) denied("TEMPORARILY_UNAVAILABLE");
    await this.hoursProvider.assertForCommand(tx, command);
  }
  async bankPayment(
    tx: Prisma.TransactionClient,
    context: {
      tenantId: string;
      branchId: string;
      actorUserId: string;
      operation: string;
      body: unknown;
    },
  ): Promise<void> {
    if (!this.paymentProvider) denied("PAYMENT_EVIDENCE_REQUIRED");
    await this.paymentProvider.assertForContext(tx, context);
  }
}
