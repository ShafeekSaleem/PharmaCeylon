import { Injectable, Optional } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { OnlineTerminalCommand } from "@pharmaceylon/shared";
import { denied } from "../terminals/terminal-wire";
import { OperatingHoursEvidence } from "../terminals/operating-hours.evidence";
import { SupplierPaymentEvidenceService } from "../purchasing/ledger/supplier-payment-evidence.service";

/** Integration ports for server-resolved evidence. No owner/manager shortcut and no
 * caller-supplied verified booleans. Real domain providers must bind the exact command,
 * staff, branch, amount/products and applicable mandatory restrictions.
 */
@Injectable()
export class MandatoryOperationEvidence {
  /** The application module installs the real branch-hours provider (P1 MR 7). Without one —
   * a bare instance in a test or script — the hours port keeps failing closed. */
  constructor(
    @Optional() private readonly hoursProvider?: OperatingHoursEvidence,
    @Optional()
    private readonly paymentProvider?: SupplierPaymentEvidenceService,
  ) {}

  async clinical(
    _tx: Prisma.TransactionClient,
    _command: OnlineTerminalCommand<unknown>,
  ): Promise<void> {
    denied("PHARMACIST_REQUIRED");
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
