import { createHash } from "node:crypto";
import {
  offlineReceiptNumber,
  offlineReceiptSequence,
  offlineSalePolicyError,
  type BranchStockSnapshot,
  type ExternalCardAttemptRecord,
  type OfflinePayment,
  type OfflineSaleCommand,
  type Signed,
  type StockSnapshotDisplay,
  type StockSnapshotLine,
  type TerminalErrorCode,
} from "@pharmaceylon/shared";
import { fromMinor } from "../checkout/money";
import type { PosDatabase } from "../db/database";
import type { Logger } from "../logging/logger";
import type { ReceiptSale } from "../printing/receipt-html";
import { readInstalledOfflineAuthority } from "./offline-authority";
import type { OfflineCounterService } from "./offline-counter";
import type { OfflineJournalWriter } from "./offline-journal-writer";
import {
  notUsedEvent,
  OfflineSupportRecordWriter,
} from "./offline-support-records";
import { NEVER_CHARGED_MARKER } from "./offline-support-service";
import { ActionFailure } from "./terminal-service";

/**
 * P4 #50: selling on the nominated counter while it is offline (D2, D5, D6).
 *
 * **What can be sold.** Only what the installed, server-signed stock snapshot lists: the server
 * leaves prescription and controlled products out of it (D2), so they are refused here as "not
 * sold offline". A batch under stock review, past its sell-before instant, or already used up by
 * this snapshot's online and offline sales is refused too. Prices are the snapshot's own, with
 * no discount or override (D6), and tax is rounded half-up per line exactly as the shared policy
 * checks it.
 *
 * **Paying.** Cash, a card on the separate card machine, or both (D5). A card payment is saved as
 * `prepared` *before* the machine is asked to charge, bound to this cart's digest; the person then
 * records what the machine did. One card payment at a time per sale: a second can't be started
 * while the first is unsettled or approved but not yet used, so card + card never happens; a
 * declined one can be followed by another. A sale only completes with every card payment for its
 * cart settled — the approved one becomes its payment, declined ones are left out — so a charge
 * that may have gone through is never followed by a second one or by a sale without it.
 *
 * **An approved charge no sale will use** (the customer changed their mind, or the cart can no
 * longer be sold: a batch passed its sell-before, the grant ended) is recorded `not_used` —
 * reversed on the card machine with that slip's reference, or a refund owed. That ends it here,
 * so the reconnect drain can finish, and the server holds it for a manager to check the money.
 *
 * **Committing.** The sale is checked with the shared `offlineSalePolicyError` (the one the
 * server replays with), signed, and written in one transaction with everything that follows from
 * it: the journal entry (and its stock usage), the cash it puts in the shift's drawer, the card
 * payments linked to it, and the receipt. Committing is keyed by the checkout draft, so tapping
 * Pay twice gives the customer one sale.
 */

export type OfflineSaleItem = { snapshotLineId: string; quantity: number };

export type OfflineBlockReason =
  | "NOT_SOLD_OFFLINE"
  | "STOCK_REVIEW"
  | "EXPIRED"
  | "NOT_ENOUGH_STOCK";

export const BLOCK_MESSAGES: Record<OfflineBlockReason, string> = {
  NOT_SOLD_OFFLINE:
    "Not sold while offline: prescription and controlled items, and anything not in the saved stock, wait for the connection.",
  STOCK_REVIEW:
    "This batch's stock is being checked, so it can't be sold offline.",
  EXPIRED: "This batch has expired.",
  NOT_ENOUGH_STOCK: "Not enough of this batch left in the saved stock.",
};

export type OfflineQuoteLine = {
  snapshotLineId: string;
  productId: string;
  batchId: string;
  quantity: number;
  unitPriceMinor: number;
  taxMinor: number;
  lineTotalMinor: number;
  /** Name, strength, barcode and batch number from the signed snapshot; null in one issued before
   * it carried them. */
  display: StockSnapshotDisplay | null;
};

export type OfflineQuote = {
  lines: OfflineQuoteLine[];
  blocked: {
    snapshotLineId: string;
    quantity: number;
    reason: OfflineBlockReason;
    remaining: number | null;
  }[];
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  /** Binds a card payment to exactly this cart; any change to it needs a new one. */
  digest: string;
};

export type OfflineStockLine = {
  snapshotLineId: string;
  productId: string;
  batchId: string;
  remaining: number;
  unitPriceMinor: number;
  sellBefore: number;
  blocked: OfflineBlockReason | null;
  display: StockSnapshotDisplay | null;
};

export type OfflineReceipt = {
  /** Final (option A): the server keeps it as the sale's invoice number. */
  receiptNumber: string;
  saleCommandId: string;
  checkoutDraftId: string;
  soldAt: number;
  sellerName: string;
  lines: OfflineQuoteLine[];
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  payments: OfflinePayment[];
  changeMinor: number;
};

export type OfflineCardOutcome =
  | { kind: "not_sure" }
  | {
      kind: "approved";
      reference: string;
      approvalCode: string;
      approvedAt: number;
    }
  | { kind: "declined"; reference: string }
  | { kind: "never_charged" }
  | {
      kind: "not_used";
      settlement: "reversed_on_machine" | "refund_owed";
      reversalReference: string | null;
      reason: string;
    };

const POLICY_MESSAGES: Partial<Record<TerminalErrorCode, string>> = {
  LOCAL_STOCK_EXHAUSTED: BLOCK_MESSAGES.NOT_ENOUGH_STOCK,
  RECONCILIATION_REQUIRED: BLOCK_MESSAGES.STOCK_REVIEW,
  ONLINE_REQUIRED: "Something in this sale needs the connection.",
  SNAPSHOT_STALE:
    "The saved stock was too old when the connection was lost, so nothing can be sold offline.",
  SNAPSHOT_MISMATCH: "The saved stock changed. Start the sale again.",
  GRANT_EXPIRED:
    "This counter's offline permission has ended. Reconnect to continue.",
  GRANT_INVALID:
    "This counter's offline permission isn't valid. Reconnect to continue.",
  BUSINESS_HOURS_ACK_REQUIRED: "It's outside selling hours.",
  OUTSIDE_OPERATING_HOURS: "Selling isn't allowed at this time.",
  PAYMENT_NOT_ALLOWED: "That payment can't be taken while offline.",
  SESSION_INVALID:
    "That doesn't match the shift on this till. Sign in again with your PIN.",
  CLOCK_UNTRUSTED: "This counter can't trust its clock. Reconnect to continue.",
};

type AttemptRow = { attempt_id: string; envelope_json: string };

/** A card payment left unsettled on this counter, and the cart it was for. */
export type OpenOfflineCard = {
  checkoutDraftId: string;
  items: OfflineSaleItem[] | null;
  /** What that cart comes to now, from the saved stock; null without the cart. */
  totalMinor: number | null;
  attempt: {
    attemptId: string;
    amountMinor: number;
    state: "prepared" | "uncertain" | "approved";
    reference: string | null;
    approvalCode: string | null;
  };
};

export type OfflineSaleDeps = {
  db: PosDatabase;
  counter: Pick<OfflineCounterService, "saleContext" | "settlementContext">;
  journal: Pick<
    OfflineJournalWriter,
    "appendSignedCommand" | "getBatchUsageQuantities"
  >;
  logger?: Pick<Logger, "info" | "warn">;
};

/** Exact half-up tax on a line's net, never binary floating point (as the shared policy checks). */
function lineTax(netMinor: number, basisPoints: number): number {
  return Number((BigInt(netMinor) * BigInt(basisPoints) + 5000n) / 10000n);
}

export class OfflineSaleService {
  constructor(private readonly deps: OfflineSaleDeps) {}

  private snapshot(enrollmentId: string): BranchStockSnapshot {
    const installed = readInstalledOfflineAuthority(this.deps.db, enrollmentId);
    if (!installed)
      throw new ActionFailure(
        "NO_OFFLINE_AUTHORITY",
        "This counter has no offline permission installed.",
      );
    return installed.snapshot.payload;
  }

  private blockFor(
    line: StockSnapshotLine,
    remaining: number,
    now: number,
  ): OfflineBlockReason | null {
    if (line.stockReviewRequired) return "STOCK_REVIEW";
    if (now >= line.sellBefore) return "EXPIRED";
    if (remaining <= 0) return "NOT_ENOUGH_STOCK";
    return null;
  }

  /** What the saved stock still lets this counter sell offline, line by line. */
  stock(): OfflineStockLine[] {
    const { ready } = this.deps.counter.saleContext();
    const snapshot = this.snapshot(ready.enrollmentId);
    const used = this.deps.journal.getBatchUsageQuantities(ready.enrollmentId);
    return snapshot.lines.map((line) => {
      const remaining = Math.max(
        0,
        line.availableQuantity - (used[line.snapshotLineId] ?? 0),
      );
      return {
        snapshotLineId: line.snapshotLineId,
        productId: line.productId,
        batchId: line.batchId,
        remaining,
        unitPriceMinor: line.unitPriceMinor,
        sellBefore: line.sellBefore,
        blocked: this.blockFor(line, remaining, ready.trustedNow),
        display: line.display ?? null,
      };
    });
  }

  /** Prices a cart from the saved stock, and says which items can't be sold offline and why. */
  quote(items: OfflineSaleItem[]): OfflineQuote {
    const { ready } = this.deps.counter.saleContext();
    return this.price(ready.enrollmentId, ready.trustedNow, items);
  }

  private price(
    enrollmentId: string,
    now: number,
    items: OfflineSaleItem[],
  ): OfflineQuote {
    const snapshot = this.snapshot(enrollmentId);
    const used = this.deps.journal.getBatchUsageQuantities(enrollmentId);
    // The same batch twice in a cart is one line (the policy refuses repeated lines).
    const merged = new Map<string, number>();
    for (const item of items) {
      if (!Number.isSafeInteger(item.quantity) || item.quantity < 1)
        throw new ActionFailure(
          "INVALID_QUANTITY",
          "Quantities are whole numbers from 1.",
        );
      merged.set(
        item.snapshotLineId,
        (merged.get(item.snapshotLineId) ?? 0) + item.quantity,
      );
    }
    const quote: OfflineQuote = {
      lines: [],
      blocked: [],
      subtotalMinor: 0,
      taxMinor: 0,
      totalMinor: 0,
      digest: "",
    };
    for (const [snapshotLineId, quantity] of merged) {
      const known = snapshot.lines.find(
        (l) => l.snapshotLineId === snapshotLineId,
      );
      if (!known) {
        quote.blocked.push({
          snapshotLineId,
          quantity,
          reason: "NOT_SOLD_OFFLINE",
          remaining: null,
        });
        continue;
      }
      const remaining = Math.max(
        0,
        known.availableQuantity - (used[snapshotLineId] ?? 0),
      );
      const reason =
        this.blockFor(known, remaining, now) ??
        (quantity > remaining ? "NOT_ENOUGH_STOCK" : null);
      if (reason) {
        quote.blocked.push({ snapshotLineId, quantity, reason, remaining });
        continue;
      }
      const net = quantity * known.unitPriceMinor;
      const tax = lineTax(net, known.taxBasisPoints);
      quote.lines.push({
        snapshotLineId,
        productId: known.productId,
        batchId: known.batchId,
        quantity,
        unitPriceMinor: known.unitPriceMinor,
        taxMinor: tax,
        lineTotalMinor: net + tax,
        display: known.display ?? null,
      });
      quote.subtotalMinor += net;
      quote.taxMinor += tax;
    }
    quote.totalMinor = quote.subtotalMinor + quote.taxMinor;
    quote.digest = createHash("sha256")
      .update(
        JSON.stringify([
          snapshot.snapshotId,
          snapshot.snapshotVersion,
          quote.lines.map((l) => [
            l.snapshotLineId,
            l.quantity,
            l.unitPriceMinor,
            l.taxMinor,
          ]),
          quote.blocked.map((b) => [b.snapshotLineId, b.quantity]),
          quote.totalMinor,
        ]),
        "utf8",
      )
      .digest("hex");
    return quote;
  }

  private sellable(
    enrollmentId: string,
    now: number,
    items: OfflineSaleItem[],
  ): OfflineQuote {
    const quote = this.price(enrollmentId, now, items);
    if (quote.blocked.length)
      throw new ActionFailure(
        "ITEMS_BLOCKED",
        quote.blocked.map((b) => BLOCK_MESSAGES[b.reason]).join(" "),
      );
    if (!quote.lines.length)
      throw new ActionFailure("EMPTY_SALE", "Add something to the sale first.");
    return quote;
  }

  /** Every card payment started for this cart, each with its events in order. */
  private attempts(enrollmentId: string, checkoutDraftId: string) {
    const rows = this.deps.db
      .prepare(
        `SELECT attempt_id, envelope_json FROM offline_support_record
         WHERE enrollment_id = ? AND kind = 'external_card_attempt' AND attempt_id IN (
           SELECT attempt_id FROM offline_support_record
           WHERE enrollment_id = ? AND kind = 'external_card_attempt'
             AND json_extract(envelope_json, '$.payload.checkoutDraftId') = ?)
         ORDER BY rowid`,
      )
      .all(enrollmentId, enrollmentId, checkoutDraftId) as AttemptRow[];
    const byAttempt = new Map<string, ExternalCardAttemptRecord[]>();
    for (const row of rows) {
      const events = byAttempt.get(row.attempt_id) ?? [];
      events.push(
        (JSON.parse(row.envelope_json) as Signed<ExternalCardAttemptRecord>)
          .payload,
      );
      byAttempt.set(row.attempt_id, events);
    }
    return [...byAttempt].map(([attemptId, events]) => ({
      attemptId,
      first: events[0]!,
      latest: events[events.length - 1]!,
      approved: events.find((e) => e.state === "approved"),
    }));
  }

  private supportWriter(trustedNow: number) {
    // Support records carry the counter's trusted time, the same clock the sale is stamped with.
    return new OfflineSupportRecordWriter({
      db: this.deps.db,
      now: () => new Date(trustedNow),
    });
  }

  private receiptFor(checkoutDraftId: string): OfflineReceipt | null {
    const row = this.deps.db
      .prepare(
        "SELECT receipt_json FROM offline_sale_receipt WHERE checkout_draft_id = ?",
      )
      .get(checkoutDraftId) as { receipt_json: string } | undefined;
    return row ? (JSON.parse(row.receipt_json) as OfflineReceipt) : null;
  }

  private refuseFinished(checkoutDraftId: string): void {
    if (this.receiptFor(checkoutDraftId))
      throw new ActionFailure(
        "SALE_ALREADY_RECORDED",
        "This sale is already recorded. Start a new one.",
      );
  }

  /**
   * Saved before the card machine is asked to charge `amountMinor` for this cart. A card
   * payment for the same cart that isn't settled yet refuses a second one.
   */
  prepareCard(input: {
    checkoutDraftId: string;
    items: OfflineSaleItem[];
    amountMinor: number;
  }): { attemptId: string; digest: string } {
    const { ready, signIn } = this.deps.counter.saleContext();
    this.refuseFinished(input.checkoutDraftId);
    const quote = this.sellable(
      ready.enrollmentId,
      ready.trustedNow,
      input.items,
    );
    // One card payment per sale (the writer refuses a second while one is unsettled or unused),
    // so the card can take at most the whole total; cash covers the rest.
    if (input.amountMinor > quote.totalMinor)
      throw new ActionFailure(
        "CARD_OVER_TOTAL",
        "That's more than this sale comes to.",
      );
    // One card on the machine per counter: a second sale can't start a card while another
    // sale's card is unsettled, so that one is never left behind.
    const open = this.openAttempt(ready.enrollmentId);
    if (open && open.first.checkoutDraftId !== input.checkoutDraftId)
      throw new ActionFailure(
        "CARD_UNRESOLVED",
        "Another sale's card payment isn't settled. Finish that sale, or record what the card machine did, first.",
      );
    try {
      // The cart is kept beside the attempt, so Sell can show this card again if it closes.
      const signed = this.deps.db.transaction(() => {
        const prepared = this.supportWriter(
          ready.trustedNow,
        ).prepareCardAttempt({
          key: ready.key,
          staffSignInId: signIn.staffSignInId,
          checkoutDraftId: input.checkoutDraftId,
          reviewedSaleDigest: quote.digest,
          amountMinor: input.amountMinor,
        });
        this.deps.db
          .prepare(
            `INSERT INTO offline_card_cart (attempt_id, enrollment_id, checkout_draft_id, items_json, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            prepared.payload.attemptId,
            ready.enrollmentId,
            input.checkoutDraftId,
            JSON.stringify(
              input.items.map((i) => ({
                snapshotLineId: i.snapshotLineId,
                quantity: i.quantity,
              })),
            ),
            new Date().toISOString(),
          );
        return prepared;
      })();
      return { attemptId: signed.payload.attemptId, digest: quote.digest };
    } catch (error) {
      return cardRefused(error);
    }
  }

  /** The newest card payment on this counter that isn't settled for good, with its events. */
  private openAttempt(enrollmentId: string) {
    const row = this.deps.db
      .prepare(
        `SELECT r.attempt_id FROM offline_support_record r
         WHERE r.enrollment_id = ? AND r.kind = 'external_card_attempt'
           AND r.card_state IN ('prepared', 'uncertain', 'approved')
           AND r.rowid = (SELECT MAX(rowid) FROM offline_support_record
                          WHERE enrollment_id = r.enrollment_id AND attempt_id = r.attempt_id)
         ORDER BY r.rowid DESC LIMIT 1`,
      )
      .get(enrollmentId) as { attempt_id: string } | undefined;
    if (!row) return null;
    const events = (
      this.deps.db
        .prepare(
          `SELECT envelope_json FROM offline_support_record
           WHERE enrollment_id = ? AND attempt_id = ? ORDER BY rowid`,
        )
        .all(enrollmentId, row.attempt_id) as { envelope_json: string }[]
    ).map(
      (r) =>
        (JSON.parse(r.envelope_json) as Signed<ExternalCardAttemptRecord>)
          .payload,
    );
    return {
      attemptId: row.attempt_id,
      first: events[0]!,
      latest: events[events.length - 1]!,
      approved: events.find((e) => e.state === "approved"),
    };
  }

  /**
   * The card payment this counter left on the machine, with the cart it was prepared for, so Sell
   * can show it again after a person switch, a reload or a restart. Null when none is open.
   * `items` is null when the cart wasn't kept (a card prepared before this was recorded): the
   * charge can then only be recorded as not used.
   */
  openCard(): OpenOfflineCard | null {
    const { enrollmentId, trustedNow } = this.deps.counter.settlementContext();
    const open = this.openAttempt(enrollmentId);
    if (!open) return null;
    const kept = this.deps.db
      .prepare(
        "SELECT items_json FROM offline_card_cart WHERE attempt_id = ? AND enrollment_id = ?",
      )
      .get(open.attemptId, enrollmentId) as { items_json: string } | undefined;
    const items = kept
      ? (JSON.parse(kept.items_json) as OfflineSaleItem[])
      : null;
    const approved =
      open.approved?.state === "approved" ? open.approved : undefined;
    return {
      checkoutDraftId: open.first.checkoutDraftId,
      items,
      totalMinor: items
        ? this.price(enrollmentId, trustedNow, items).totalMinor
        : null,
      attempt: {
        attemptId: open.attemptId,
        amountMinor: open.first.amountMinor,
        state: open.latest.state as OpenOfflineCard["attempt"]["state"],
        reference: approved?.providerReference ?? null,
        approvalCode: approved?.approvalCode ?? null,
      },
    };
  }

  /** What the card machine did with a prepared card payment, as the person at the counter saw it. */
  recordCardOutcome(input: {
    attemptId: string;
    outcome: OfflineCardOutcome;
  }): { state: ExternalCardAttemptRecord["state"] } {
    const { outcome } = input;
    if (outcome.kind === "not_used")
      return this.recordNotUsed(input.attemptId, outcome);
    const { ready, signIn } = this.deps.counter.saleContext();
    const writer = this.supportWriter(ready.trustedNow);
    const verifiedByUserId = signIn.session.staffUserId;
    try {
      const signed = writer.recordCardAttemptEvent({
        key: ready.key,
        attemptId: input.attemptId,
        staffSignInId: signIn.staffSignInId,
        event:
          outcome.kind === "not_sure"
            ? { state: "uncertain" }
            : outcome.kind === "approved"
              ? {
                  state: "approved",
                  providerReference: outcome.reference,
                  approvalCode: outcome.approvalCode,
                  approvedAt: outcome.approvedAt,
                }
              : outcome.kind === "declined"
                ? {
                    state: "declined",
                    providerReference: outcome.reference,
                    verifiedByUserId,
                  }
                : {
                    state: "declined",
                    providerReference: `${NEVER_CHARGED_MARKER}-${input.attemptId.slice(0, 8)}`,
                    verifiedByUserId,
                  },
      });
      return { state: signed.payload.state };
    } catch (error) {
      return cardRefused(error);
    }
  }

  /**
   * An approved card payment no sale will use: reversed on the card machine, or owed back. Works
   * while the outage is still open even if selling has stopped (the grant ended, the counter is
   * reconnecting), since the drain can't finish until it's settled.
   */
  private recordNotUsed(
    attemptId: string,
    outcome: Extract<OfflineCardOutcome, { kind: "not_used" }>,
  ): { state: ExternalCardAttemptRecord["state"] } {
    const { key, trustedNow, signIn } = this.deps.counter.settlementContext();
    try {
      const signed = this.supportWriter(trustedNow).recordCardAttemptEvent({
        key,
        attemptId,
        staffSignInId: signIn.staffSignInId,
        event: notUsedEvent(outcome, signIn.session.staffUserId),
      });
      this.deps.logger?.info("offline.card_not_used", {
        attemptId,
        settlement: outcome.settlement,
      });
      return { state: signed.payload.state };
    } catch (error) {
      return cardRefused(error);
    }
  }

  /**
   * Completes the sale: every card payment for this cart settled (approved ones are its card
   * payments), and cash for the rest. Returns the receipt; a second call for the same draft
   * returns the same one.
   */
  commit(input: {
    checkoutDraftId: string;
    items: OfflineSaleItem[];
    cashTenderedMinor?: number;
  }): OfflineReceipt {
    const done = this.receiptFor(input.checkoutDraftId);
    if (done) return done;
    const context = this.deps.counter.saleContext();
    const { ready, signIn } = context;
    const enrollmentId = ready.enrollmentId;
    const snapshot = this.snapshot(enrollmentId);
    const quote = this.sellable(enrollmentId, ready.trustedNow, input.items);

    const cards: Extract<OfflinePayment, { method: "external_card" }>[] = [];
    const linked: { attemptId: string; providerReference: string }[] = [];
    for (const attempt of this.attempts(enrollmentId, input.checkoutDraftId)) {
      const state = attempt.latest.state;
      if (state === "declined" || state === "not_used") continue;
      if (state === "prepared" || state === "uncertain")
        throw new ActionFailure(
          "CARD_UNRESOLVED",
          "A card payment for this sale isn't settled. Check what the card machine did and record it first.",
        );
      if (state !== "approved" || attempt.approved?.state !== "approved")
        continue;
      if (attempt.first.reviewedSaleDigest !== quote.digest)
        throw new ActionFailure(
          "CARD_FOR_OTHER_CART",
          "The sale changed after a card was charged for it. Put it back as it was, or reverse that charge on the card machine (or note the refund owed) and record it as not used.",
        );
      cards.push({
        method: "external_card",
        amountMinor: attempt.first.amountMinor,
        providerReference: attempt.approved.providerReference,
        approvalCode: attempt.approved.approvalCode,
        approvedAt: attempt.approved.approvedAt,
      });
      linked.push({
        attemptId: attempt.attemptId,
        providerReference: attempt.approved.providerReference,
      });
    }
    const cardMinor = cards.reduce((sum, c) => sum + c.amountMinor, 0);
    if (cardMinor > quote.totalMinor)
      throw new ActionFailure(
        "CARD_OVER_TOTAL",
        "The card payments come to more than the sale.",
      );
    const cashDue = quote.totalMinor - cardMinor;
    const tendered = input.cashTenderedMinor ?? 0;
    if (!Number.isSafeInteger(tendered) || tendered < 0)
      throw new ActionFailure("INVALID_AMOUNT", "Enter the cash handed over.");
    if (tendered < cashDue)
      throw new ActionFailure(
        "CASH_SHORT",
        "The cash handed over doesn't cover what's left to pay.",
      );
    if (cashDue === 0 && tendered > 0)
      throw new ActionFailure(
        "INVALID_AMOUNT",
        "The cards already cover this sale: no cash is due.",
      );
    const changeMinor = tendered - cashDue;
    const payments: OfflinePayment[] = [
      ...cards,
      ...(cashDue > 0
        ? [
            {
              method: "cash" as const,
              amountMinor: cashDue,
              tenderedMinor: tendered,
              changeMinor,
            },
          ]
        : []),
    ];

    const receiptNumber = this.nextReceiptNumber(ready.grant.receiptNumbering);
    const command: OfflineSaleCommand = {
      ...context.command(),
      kind: "ordinary_sale",
      receiptNumber,
      snapshotId: snapshot.snapshotId,
      snapshotVersion: snapshot.snapshotVersion,
      currency: "LKR",
      lines: quote.lines.map((l) => ({
        snapshotLineId: l.snapshotLineId,
        quantity: l.quantity,
        unitPriceMinor: l.unitPriceMinor,
        discountMinor: 0,
        taxMinor: l.taxMinor,
      })),
      payments,
      totalMinor: quote.totalMinor,
    };
    const error = offlineSalePolicyError(
      ready.grant,
      snapshot,
      command,
      {
        grantId: ready.grant.grantId,
        grantVersion: ready.grant.grantVersion,
        snapshotId: snapshot.snapshotId,
        snapshotVersion: snapshot.snapshotVersion,
        offlineSessionId: ready.outage.offlineSessionId,
        offlineStartedAt: ready.outage.offlineStartedAt,
        quantities: this.deps.journal.getBatchUsageQuantities(enrollmentId),
      },
      ready.trustedNow,
      "offline",
      signIn,
      context.openShift,
      context.hours,
    );
    if (error)
      throw new ActionFailure(
        error,
        POLICY_MESSAGES[error] ?? "This sale can't be completed offline.",
      );

    const envelope = ready.key.sign(command, "command");
    const receipt: OfflineReceipt = {
      receiptNumber,
      saleCommandId: command.commandId,
      checkoutDraftId: input.checkoutDraftId,
      soldAt: command.occurredAt,
      sellerName: context.sellerName,
      lines: quote.lines,
      subtotalMinor: quote.subtotalMinor,
      taxMinor: quote.taxMinor,
      totalMinor: quote.totalMinor,
      payments,
      changeMinor,
    };
    const at = new Date(ready.trustedNow).toISOString();
    const workSessionId = context.openShift.session.workSessionId;
    const writer = this.supportWriter(ready.trustedNow);
    this.deps.db.transaction(() => {
      this.deps.journal.appendSignedCommand(envelope);
      if (cashDue > 0) {
        this.deps.db
          .prepare(
            `INSERT INTO till_shift_posting (id, work_session_id, kind, cash_in_minor, change_minor, cash_out_minor, at)
             VALUES (?, ?, 'sale', ?, ?, 0, ?)`,
          )
          .run(
            `offline-sale:${command.commandId}`,
            workSessionId,
            tendered,
            changeMinor,
            at,
          );
        this.deps.db
          .prepare(
            "UPDATE till_shift SET expected_cash_minor = expected_cash_minor + ?, updated_at = ? WHERE work_session_id = ? AND state = 'open'",
          )
          .run(cashDue, at, workSessionId);
      }
      for (const card of linked)
        writer.recordCardAttemptEvent({
          key: ready.key,
          attemptId: card.attemptId,
          staffSignInId: signIn.staffSignInId,
          event: {
            state: "linked_to_sale",
            providerReference: card.providerReference,
            saleCommandId: command.commandId,
          },
        });
      this.deps.db
        .prepare(
          `INSERT INTO offline_sale_receipt (checkout_draft_id, enrollment_id, command_id, receipt_number, receipt_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.checkoutDraftId,
          enrollmentId,
          command.commandId,
          receiptNumber,
          JSON.stringify(receipt),
          at,
        );
    })();
    this.deps.logger?.info("offline.sale_committed", {
      saleCommandId: command.commandId,
      lines: command.lines.length,
      cards: cards.length,
    });
    return receipt;
  }

  /**
   * The next receipt number under this till's prefix: after the highest this store ever gave, and
   * never below the grant's floor (what the server has already seen from this till, which is what
   * a replaced or restored counter starts from). Read and used in one synchronous commit, so no
   * other sale can take it in between; the unique index is the backstop.
   */
  private nextReceiptNumber(numbering: {
    prefix: string;
    nextNumber: number;
  }): string {
    const rows = this.deps.db
      .prepare(
        "SELECT receipt_number FROM offline_sale_receipt WHERE receipt_number LIKE ? ORDER BY length(receipt_number) DESC, receipt_number DESC LIMIT 1",
      )
      .all(`${numbering.prefix}-%`) as { receipt_number: string }[];
    const highest = rows.length
      ? (offlineReceiptSequence(numbering.prefix, rows[0]!.receipt_number) ?? 0)
      : 0;
    return offlineReceiptNumber(
      numbering.prefix,
      Math.max(numbering.nextNumber, highest + 1),
    );
  }

  /** A receipt of a sale committed here, for reprinting. */
  receipt(saleCommandId: string): OfflineReceipt | null {
    const row = this.deps.db
      .prepare(
        "SELECT receipt_json FROM offline_sale_receipt WHERE command_id = ?",
      )
      .get(saleCommandId) as { receipt_json: string } | undefined;
    return row ? (JSON.parse(row.receipt_json) as OfflineReceipt) : null;
  }
}

const CARD_REFUSALS: Readonly<Record<string, string>> = {
  INVALID_RECORD: "Check what you entered and try again.",
  CARD_NUMBER_IN_TEXT:
    "That looks like a card number. Never type a card number here.",
  EXTERNAL_CARD_NOT_ALLOWED:
    "Card payments from a separate card machine are not allowed on this counter while it is offline.",
  ATTEMPT_UNRESOLVED:
    "A card payment for this sale hasn't been settled yet. Find out what the card machine did before anyone is charged again.",
  UNKNOWN_ATTEMPT: "That card payment is not recorded on this counter.",
  INVALID_TRANSITION:
    "That card payment has already moved on and can't be changed that way.",
  ATTEMPT_MISMATCH:
    "That card machine reference doesn't match the one already saved for this payment.",
  STAFF_NOT_AUTHORIZED:
    "Only someone prepared to sell offline on this counter can confirm a decline.",
  GRANT_EXPIRED: POLICY_MESSAGES.GRANT_EXPIRED!,
  NO_OFFLINE_AUTHORITY: "This counter has no offline permission installed.",
  RECONCILIATION_REQUIRED:
    "This counter's records have to be checked online first.",
};

function cardRefused(error: unknown): never {
  if (error instanceof ActionFailure) throw error;
  const code = error instanceof Error ? error.message : "";
  const message = CARD_REFUSALS[code];
  if (message) throw new ActionFailure(code, message);
  throw error;
}

/** How a line reads on screen and on paper: name and strength, else the batch (older snapshot). */
export function offlineLineLabel(
  line: Pick<OfflineQuoteLine, "batchId" | "display">,
): string {
  if (!line.display) return `Item, batch ${line.batchId.slice(0, 8)}`;
  const { name, strength } = line.display;
  return strength && !name.includes(strength) ? `${name} ${strength}` : name;
}

/**
 * An offline receipt in the printed receipt's shape: a normal receipt, numbered with the counter's
 * own final number (option A), with no offline wording.
 */
export function offlineReceiptForPrinting(
  receipt: OfflineReceipt,
): ReceiptSale {
  const paid = receipt.payments.reduce(
    (sum, p) => sum + (p.method === "cash" ? p.tenderedMinor : p.amountMinor),
    0,
  );
  return {
    invoiceNo: receipt.receiptNumber,
    soldAt: new Date(receipt.soldAt).toISOString(),
    subtotal: fromMinor(receipt.subtotalMinor),
    discountTotal: fromMinor(0),
    taxTotal: fromMinor(receipt.taxMinor),
    grandTotal: fromMinor(receipt.totalMinor),
    amountPaid: fromMinor(paid),
    changeDue: fromMinor(receipt.changeMinor),
    sellerName: receipt.sellerName,
    lines: receipt.lines.map((line) => ({
      name: line.display
        ? `${offlineLineLabel(line)} (batch ${line.display.batchNo})`
        : offlineLineLabel(line),
      qty: line.quantity,
      unitPrice: fromMinor(line.unitPriceMinor),
      lineTotal: fromMinor(line.lineTotalMinor),
    })),
    payments: receipt.payments.map((p) =>
      p.method === "cash"
        ? {
            method: "cash",
            amount: fromMinor(p.tenderedMinor),
            reference: null,
          }
        : {
            method: "card",
            amount: fromMinor(p.amountMinor),
            reference: p.providerReference,
          },
    ),
  };
}
