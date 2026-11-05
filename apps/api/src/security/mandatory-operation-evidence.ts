import { Injectable, Optional } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { OnlineTerminalCommand } from "@pharmaceylon/shared";
import { denied } from "../terminals/terminal-wire";
import { OperatingHoursEvidence } from "../terminals/operating-hours.evidence";
import { SupplierPaymentEvidenceService } from "../purchasing/ledger/supplier-payment-evidence.service";
import { PharmacistRegistrationService } from "../clinical/pharmacist-registration.service";
import { type CommandClinicalEvidence, PharmacistCosignService } from "../clinical/pharmacist-cosign.service";

/** Integration ports for server-resolved evidence. No owner/manager shortcut and no
 * caller-supplied verified booleans. Real domain providers must bind the exact command,
 * staff, branch, amount/products and applicable mandatory restrictions.
 */
@Injectable()
export class MandatoryOperationEvidence {
  /** The application module installs the real branch-hours (P1 MR 7) and pharmacist-registration
   * providers. Without one — a bare instance in a test or script — that port keeps failing closed.
   * A missing hours provider is how the instance was built, not a passing fault, so it refuses
   * with `BRANCH_HOURS_NOT_CONFIGURED`, which is never retryable. */
  constructor(
    @Optional() private readonly hoursProvider?: OperatingHoursEvidence,
    @Optional()
    private readonly paymentProvider?: SupplierPaymentEvidenceService,
    @Optional()
    private readonly clinicalProvider?: PharmacistRegistrationService,
    @Optional()
    private readonly cosignProvider?: PharmacistCosignService,
  ) {}

  /** A current SLMC registration an owner recorded (P1 #47): the signed session's staff member's
   * own, or, when the command carries `pharmacistEvidenceId`, the co-signing pharmacist's, whose
   * PIN co-sign is spent here. No role, permission or ownership substitutes for it. Returns the
   * registration relied on and whose it is, for the operation's provenance. */
  async clinical(
    tx: Prisma.TransactionClient,
    command: OnlineTerminalCommand<unknown>,
  ): Promise<CommandClinicalEvidence> {
    if (command.pharmacistEvidenceId !== null) {
      if (!this.cosignProvider) denied("PHARMACIST_REQUIRED");
      return this.cosignProvider.consume(tx, command);
    }
    if (!this.clinicalProvider) denied("PHARMACIST_REQUIRED");
    const own = await this.clinicalProvider.assertForCommand(tx, command);
    return { ...own, pharmacistUserId: command.session.staffUserId, pharmacistEvidenceId: null };
  }
  async hours(
    tx: Prisma.TransactionClient,
    command: OnlineTerminalCommand<unknown>,
  ): Promise<void> {
    if (!this.hoursProvider) denied("BRANCH_HOURS_NOT_CONFIGURED");
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
