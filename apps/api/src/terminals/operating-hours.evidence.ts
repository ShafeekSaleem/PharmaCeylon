import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { OnlineTerminalCommand, SignedPhysicalOperation } from "@pharmaceylon/shared";
import { evaluateOperatingHours } from "./operating-hours";
import { denied, invalid } from "./terminal-wire";

/**
 * Revised D8 limits *new sales and shift opening* to selling hours; counting cash and closing an
 * existing shift stay available, and the contract puts no hours limit on back-room stock work.
 * Operations listed here are reviewed as not selling-time restricted (decided 2026-10-29). Every other operation —
 * including any adapter added later and not reviewed here — is checked against selling hours
 * and fails closed when they are unknown.
 */
export const OPERATIONS_WITHOUT_SELLING_HOURS: ReadonlySet<string> = new Set<SignedPhysicalOperation>([
  "POST /api/v1/stocktakes/:id/post",
  "POST /api/v1/inventory/held-adjustments/:id/post",
  "POST /api/v1/purchasing/held-deliveries/:id/post",
  "POST /api/v1/products/import/:importId/stock/post",
  "POST /api/v1/products/import/:importId/undo-stock",
]);

/**
 * The real operating-hours provider for online signed commands (P1 #47, revised D8).
 *
 * Reads the branch's structured hours, confirmed dated exceptions (including gazette holidays a
 * person accepted), mandatory limits and unrevoked business extensions on the caller's
 * transaction, at the time the command is authorized:
 *
 * - unset/unreadable hours, an unusable timezone or an inactive branch → `TEMPORARILY_UNAVAILABLE`;
 * - outside a mandatory limit → `OUTSIDE_OPERATING_HOURS` (nobody can override it);
 * - outside routine hours with no extension → `BUSINESS_HOURS_ACK_REQUIRED`: online, the remedy
 *   is a business extension approved on the web (W7). The device-signed D8 acknowledgement is an
 *   offline-outage record and never authorizes an online command.
 *
 * Online commands carry no per-command hours exception: `operatingHoursExceptionId` must be null.
 */
@Injectable()
export class OperatingHoursEvidence {
  async assertForCommand(
    tx: Prisma.TransactionClient,
    command: OnlineTerminalCommand<unknown>,
    at: Date = this.now(),
  ): Promise<void> {
    if (command.operatingHoursExceptionId !== null) invalid();
    if (OPERATIONS_WITHOUT_SELLING_HOURS.has(command.operation)) return;
    const { tenantId, branchId } = command.identity;
    const branch = await tx.branch.findFirst({
      where: { id: branchId, tenantId, isActive: true },
      select: { operatingHours: true, timezone: true },
    });
    if (!branch) denied("TEMPORARILY_UNAVAILABLE");
    const extensions = await tx.branchHoursExtension.findMany({
      where: { tenantId, branchId, revokedAt: null, startsAt: { lte: at }, endsAt: { gt: at } },
      select: { startsAt: true, endsAt: true },
    });
    const verdict = evaluateOperatingHours(
      { hours: branch.operatingHours, timeZone: branch.timezone, extensions },
      at,
    );
    switch (verdict.kind) {
      case "open":
        return;
      case "unknown":
        denied("TEMPORARILY_UNAVAILABLE");
      case "outside_mandatory":
        denied("OUTSIDE_OPERATING_HOURS");
      case "closed":
        denied("BUSINESS_HOURS_ACK_REQUIRED");
    }
  }

  /** Server time; tests substitute a fixed clock. */
  protected now(): Date {
    return new Date();
  }
}
