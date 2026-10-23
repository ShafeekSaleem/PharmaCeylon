import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { OnlineTerminalCommand } from "@pharmaceylon/shared";
import { denied } from "../terminals/terminal-wire";

/** Integration ports for server-resolved evidence. No owner/manager shortcut and no
 * caller-supplied verified booleans. Real domain providers must bind the exact command,
 * staff, branch, amount/products and applicable mandatory restrictions.
 */
@Injectable()
export class MandatoryOperationEvidence {
  async clinical(
    _tx: Prisma.TransactionClient,
    _command: OnlineTerminalCommand<unknown>,
  ): Promise<void> {
    denied("PHARMACIST_REQUIRED");
  }
  async hours(
    _tx: Prisma.TransactionClient,
    _command: OnlineTerminalCommand<unknown>,
  ): Promise<void> {
    denied("TEMPORARILY_UNAVAILABLE");
  }
  async bankPayment(
    _tx: Prisma.TransactionClient,
    _context: {
      tenantId: string;
      branchId: string;
      actorUserId: string;
      operation: string;
      body: unknown;
    },
  ): Promise<void> {
    denied("PAYMENT_EVIDENCE_REQUIRED");
  }
}
