import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { OnlineTerminalCommand, SignedPhysicalOperation } from "@pharmaceylon/shared";
import { evaluateOperatingHours, type OperatingHoursVerdict } from "./operating-hours";
import { denied, invalid } from "./terminal-wire";

type UnknownReason = Extract<OperatingHoursVerdict, { kind: "unknown" }>["reason"];

/**
 * Why the hours are unknown decides whether a resend can help.
 *
 * - Hours never set, or a timezone the server cannot use, is the branch's own setup: a manager
 *   sets the hours, the owner fixes the timezone (saved as free text). Until then every resend
 *   gets the same answer, so `BRANCH_HOURS_NOT_CONFIGURED` (not retryable).
 * - Stored hours that fail validation are not a setting anyone chose: the hours editor and
 *   workspace provisioning validate what they save. Such a row is a server-side fault (hours
 *   written by a newer release mid-deploy, or a backfill bug), so `TEMPORARILY_UNAVAILABLE`
 *   (retryable). The hours editor logs the same row as an error.
 */
function refuseUnknownHours(reason: UnknownReason): never {
  denied(reason === "hours_invalid" ? "TEMPORARILY_UNAVAILABLE" : "BRANCH_HOURS_NOT_CONFIGURED");
}

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
  // P6: dispatching and receiving a transfer is back-room stock work (reviewed 2026-10-29).
  "POST /api/v1/transfers/:id/ship",
  "POST /api/v1/transfers/:id/receive",
  // P6: receiving a prepared delivery and sending a supplier return back are back-room stock
  // work too (reviewed 2026-10-29).
  "POST /api/v1/purchasing/prepared-receipts/:id/post",
  "POST /api/v1/returns/:id/complete",
  // P1: a direct adjustment is the same back-room stock work as posting a held one.
  "POST /api/v1/inventory/adjustments",
]);

/**
 * The real operating-hours provider for online signed commands (P1 #47, revised D8).
 *
 * Reads the branch's structured hours, confirmed dated exceptions (including gazette holidays a
 * person accepted), mandatory limits and unrevoked business extensions on the caller's
 * transaction, at the time the command is authorized:
 *
 * - unset hours, an unusable timezone or an inactive branch → `BRANCH_HOURS_NOT_CONFIGURED`
 *   (setup has to change first);
 * - stored hours that fail validation → `TEMPORARILY_UNAVAILABLE` (a server fault);
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
    if (!branch) denied("BRANCH_HOURS_NOT_CONFIGURED");
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
        refuseUnknownHours(verdict.reason);
      case "outside_mandatory":
        denied("OUTSIDE_OPERATING_HOURS");
      case "closed":
        denied("BUSINESS_HOURS_ACK_REQUIRED");
    }
  }

  /**
   * P2 online counter checkout: mandatory restrictions are hard, routine closing time stays
   * advisory online (revised D8 governs routine hours offline; online, the web extension is the
   * remedy and a sale outside routine hours is not refused).
   *
   * - outside a mandatory window → `OUTSIDE_OPERATING_HOURS` (nobody can override it);
   * - an unusable timezone or an inactive branch → `BRANCH_HOURS_NOT_CONFIGURED`, and hours stored
   *   but unreadable → `TEMPORARILY_UNAVAILABLE`, because a mandatory limit could be hiding in
   *   them (see `refuseUnknownHours`);
   * - no hours set yet → no restriction is known, so the sale goes ahead.
   */
  async assertMandatoryForSale(
    tx: Prisma.TransactionClient,
    tenantId: string,
    branchId: string,
    at: Date = this.now(),
  ): Promise<void> {
    const branch = await tx.branch.findFirst({
      where: { id: branchId, tenantId, isActive: true },
      select: { operatingHours: true, timezone: true },
    });
    if (!branch) denied("BRANCH_HOURS_NOT_CONFIGURED");
    const verdict = evaluateOperatingHours(
      { hours: branch.operatingHours, timeZone: branch.timezone, extensions: [] },
      at,
    );
    if (verdict.kind === "outside_mandatory") denied("OUTSIDE_OPERATING_HOURS");
    if (verdict.kind === "unknown" && verdict.reason !== "hours_unset")
      refuseUnknownHours(verdict.reason);
  }

  /** Server time; tests substitute a fixed clock. */
  protected now(): Date {
    return new Date();
  }
}
