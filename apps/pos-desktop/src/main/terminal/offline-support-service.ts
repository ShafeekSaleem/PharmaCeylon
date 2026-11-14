import type {
  ExternalCardAttemptRecord,
  OfflineJournalCommand,
  OfflineSaleCommand,
  OfflineSaleIncident,
  Signed,
} from "@pharmaceylon/shared";
import type { PosDatabase } from "../db/database";
import { fromMinor } from "../checkout/money";
import type {
  CardAttemptView,
  CardOutcomeInput,
  OfflineSaleView,
} from "../../shared/ipc-contract";
import type { OfflineJournalWriter } from "./offline-journal-writer";
import {
  MAX_INCIDENT_DESCRIPTION_LENGTH,
  OfflineSupportRecordWriter,
  type CardAttemptEvent,
} from "./offline-support-records";
import { ActionFailure, type TerminalService } from "./terminal-service";

/**
 * P4 #50: what the counter's screens call to note a problem with an offline sale and to settle an
 * external-card payment. It adds the three things the record writer deliberately leaves out: who is
 * signed in at this counter (and their offline sign-in), plain words for every refusal, and the
 * read side the screens list from. It never charges a card and never touches a sale.
 */

/** What each refusal of the record writer means to the person at the counter. */
const REFUSALS: Readonly<Record<string, string>> = {
  INVALID_RECORD: "Check what you entered and try again.",
  CARD_NUMBER_IN_TEXT:
    "That looks like a card number. Never type a card number here — describe the problem without it.",
  UNKNOWN_SALE: "That sale is not recorded on this counter.",
  UNKNOWN_SIGN_IN:
    "This counter has no offline sign-in for you. Sign in again, then try once more.",
  NO_DEVICE_KEY: "This counter is not set up. Contact support.",
  RECONCILIATION_REQUIRED:
    "This counter's records have to be checked online first. Nothing can be added until then.",
  NO_OFFLINE_AUTHORITY:
    "This counter has no offline permission installed, so nothing can be added.",
  GRANT_EXPIRED:
    "This counter's offline permission has ended. Nothing can be added until it is renewed online.",
  EXTERNAL_CARD_NOT_ALLOWED:
    "Card payments from a separate card machine are not allowed on this counter while it is offline.",
  ATTEMPT_UNRESOLVED:
    "A card payment for this sale has not been settled yet. Find out what the card machine did before anyone is charged again.",
  UNKNOWN_ATTEMPT: "That card payment is not recorded on this counter.",
  INVALID_TRANSITION:
    "That card payment has already moved on and cannot be changed that way.",
  ATTEMPT_MISMATCH:
    "That card machine reference does not match the one already saved for this payment.",
  STAFF_NOT_AUTHORIZED:
    "Only someone prepared to sell offline on this counter can confirm a decline.",
  SALE_PAYMENT_MISMATCH: "That sale was not paid with this card payment.",
  IDENTITY_MISMATCH: "This counter's records do not match. Contact support.",
};

function refused(error: unknown): never {
  if (error instanceof ActionFailure) throw error;
  const code = error instanceof Error ? error.message : "";
  const message = REFUSALS[code];
  if (message) throw new ActionFailure(code, message);
  throw error;
}

const MAX_LISTED_SALES = 200;
const MAX_LISTED_SETTLED = 20;

/** Stands in for the card machine's reference when a payment never reached the machine. */
export const NEVER_CHARGED_MARKER = "NOT-CHARGED";

export type { CardAttemptView, OfflineSaleView };

type AttemptRow = { attempt_id: string; envelope_json: string };

export class OfflineSupportService {
  private readonly writer: OfflineSupportRecordWriter;

  constructor(
    private readonly deps: {
      db: PosDatabase;
      terminal: Pick<TerminalService, "current">;
      journal: Pick<OfflineJournalWriter, "getActiveStaffSignInId">;
      now?: () => Date;
    },
  ) {
    this.writer = new OfflineSupportRecordWriter({
      db: deps.db,
      now: deps.now,
    });
  }

  private counter() {
    const current = this.deps.terminal.current();
    if (!current)
      throw new ActionFailure(
        "NOT_SIGNED_IN",
        "Sign in at this counter first.",
      );
    const staffSignInId = this.deps.journal.getActiveStaffSignInId(
      current.identity.enrollmentId,
    );
    if (!staffSignInId)
      throw new ActionFailure(
        "NO_OFFLINE_SIGN_IN",
        "This counter has no offline sign-in for you. Sign in again, then try once more.",
      );
    return { ...current, staffSignInId };
  }

  /** Offline sales on this counter, newest first, each with how many notes it already has. */
  sales(): OfflineSaleView[] {
    const enrollmentId = this.deps.terminal.current()?.identity.enrollmentId;
    if (!enrollmentId) return [];
    // Newest sales only: a long outage should not make this screen slower to open.
    const rows = this.deps.db
      .prepare(
        `SELECT envelope_json FROM offline_journal_command
         WHERE enrollment_id = ? AND json_extract(envelope_json, '$.payload.kind') = 'ordinary_sale'
         ORDER BY sequence DESC LIMIT ?`,
      )
      .all(enrollmentId, MAX_LISTED_SALES) as { envelope_json: string }[];
    const notes = new Map<string, number>();
    for (const row of this.deps.db
      .prepare(
        `SELECT json_extract(envelope_json, '$.payload.saleCommandId') AS sale_id, COUNT(*) AS n
         FROM offline_support_record WHERE enrollment_id = ? AND kind = 'sale_incident' GROUP BY sale_id`,
      )
      .all(enrollmentId) as { sale_id: string; n: number }[])
      notes.set(row.sale_id, row.n);
    const sales: OfflineSaleView[] = [];
    for (const row of rows) {
      const command = (
        JSON.parse(row.envelope_json) as Signed<OfflineJournalCommand>
      ).payload;
      if (command.kind !== "ordinary_sale") continue;
      const sale: OfflineSaleCommand = command;
      sales.push({
        saleCommandId: sale.commandId,
        at: new Date(sale.occurredAt).toISOString(),
        total: fromMinor(sale.totalMinor),
        itemCount: sale.lines.reduce((n, line) => n + line.quantity, 0),
        paidByCard: sale.payments.some((p) => p.method === "external_card"),
        cardPayments: sale.payments.flatMap((p) =>
          p.method === "external_card"
            ? [{ reference: p.providerReference, approvalCode: p.approvalCode }]
            : [],
        ),
        noteCount: notes.get(sale.commandId) ?? 0,
      });
    }
    return sales;
  }

  /** Every external-card payment started here, newest first; the unsettled ones come with it. */
  cardAttempts(): CardAttemptView[] {
    const enrollmentId = this.deps.terminal.current()?.identity.enrollmentId;
    if (!enrollmentId) return [];
    // Every unsettled payment, and only the latest few settled ones, read from their event rows.
    const standing = this.deps.db
      .prepare(
        `SELECT attempt_id, card_state FROM offline_support_record r
         WHERE enrollment_id = ? AND kind = 'external_card_attempt'
           AND rowid = (SELECT MAX(rowid) FROM offline_support_record
                        WHERE enrollment_id = r.enrollment_id AND attempt_id = r.attempt_id)
         ORDER BY rowid DESC`,
      )
      .all(enrollmentId) as { attempt_id: string; card_state: string }[];
    let settledSeen = 0;
    const wanted = standing
      .filter((a) => {
        if (a.card_state !== "declined" && a.card_state !== "linked_to_sale") return true;
        return ++settledSeen <= MAX_LISTED_SETTLED;
      })
      .map((a) => a.attempt_id);
    if (!wanted.length) return [];
    const rows = this.deps.db
      .prepare(
        `SELECT attempt_id, envelope_json FROM offline_support_record
         WHERE enrollment_id = ? AND kind = 'external_card_attempt'
           AND attempt_id IN (${wanted.map(() => "?").join(",")}) ORDER BY rowid`,
      )
      .all(enrollmentId, ...wanted) as AttemptRow[];
    const byAttempt = new Map<string, ExternalCardAttemptRecord[]>();
    for (const row of rows) {
      const events = byAttempt.get(row.attempt_id) ?? [];
      events.push(
        (JSON.parse(row.envelope_json) as Signed<ExternalCardAttemptRecord>)
          .payload,
      );
      byAttempt.set(row.attempt_id, events);
    }
    const views: CardAttemptView[] = [];
    for (const [attemptId, events] of byAttempt) {
      const first = events[0]!;
      const latest = events[events.length - 1]!;
      const approved = events.find((e) => e.state === "approved");
      views.push({
        attemptId,
        checkoutDraftId: first.checkoutDraftId,
        amount: fromMinor(first.amountMinor),
        startedAt: new Date(first.recordedAt).toISOString(),
        state: latest.state,
        // Declined and linked end an attempt; every other state still leaves the money open.
        settled: latest.state === "declined" || latest.state === "linked_to_sale",
        providerReference:
          events
            .map((e) => ("providerReference" in e ? e.providerReference : null))
            .find((r): r is string => r !== null) ?? null,
        approvalCode: approved?.state === "approved" ? approved.approvalCode : null,
      });
    }
    return views.reverse();
  }

  recordIncident(input: {
    saleCommandId: string;
    category: OfflineSaleIncident["category"];
    description: string;
  }): { recordedAt: string } {
    const { key, staffSignInId } = this.counter();
    if (input.description.length > MAX_INCIDENT_DESCRIPTION_LENGTH)
      throw new ActionFailure(
        "INVALID_RECORD",
        `Keep the note under ${MAX_INCIDENT_DESCRIPTION_LENGTH} characters.`,
      );
    try {
      const signed = this.writer.recordSaleIncident({
        key,
        staffSignInId,
        saleCommandId: input.saleCommandId,
        category: input.category,
        description: input.description,
      });
      return { recordedAt: new Date(signed.payload.recordedAt).toISOString() };
    } catch (error) {
      return refused(error);
    }
  }

  /** Saved before the card machine is asked to charge. Returns the attempt to settle afterwards. */
  prepareCard(input: {
    checkoutDraftId: string;
    reviewedSaleDigest: string;
    amountMinor: number;
  }): { attemptId: string } {
    const { key, staffSignInId } = this.counter();
    try {
      const signed = this.writer.prepareCardAttempt({
        key,
        staffSignInId,
        ...input,
      });
      return { attemptId: signed.payload.attemptId };
    } catch (error) {
      return refused(error);
    }
  }

  /** What happened at the card machine, or the sale it paid for. */
  recordCardOutcome(input: {
    attemptId: string;
    outcome: CardOutcomeInput;
  }): { state: ExternalCardAttemptRecord["state"] } {
    const { key, staff, staffSignInId } = this.counter();
    const { outcome } = input;
    let event: CardAttemptEvent;
    switch (outcome.kind) {
      case "not_sure":
        event = { state: "uncertain" };
        break;
      case "approved": {
        // The time on the slip, not the time it was recorded: it may be recorded long after.
        const approvedAt = Date.parse(outcome.approvedAt);
        if (!Number.isSafeInteger(approvedAt))
          throw new ActionFailure("INVALID_RECORD", REFUSALS.INVALID_RECORD!);
        event = {
          state: "approved",
          providerReference: outcome.reference,
          approvalCode: outcome.approvalCode,
          approvedAt,
        };
        break;
      }
      case "declined":
        event = {
          state: "declined",
          providerReference: outcome.reference,
          verifiedByUserId: staff.staffUserId,
        };
        break;
      case "never_charged":
        // The signed record needs a reference. There is none to copy, so it carries a plain marker
        // that cannot be mistaken for a card machine's own reference.
        event = {
          state: "declined",
          providerReference: `${NEVER_CHARGED_MARKER}-${input.attemptId.slice(0, 8)}`,
          verifiedByUserId: staff.staffUserId,
        };
        break;
      case "paid_sale":
        event = {
          state: "linked_to_sale",
          providerReference: outcome.reference,
          saleCommandId: outcome.saleCommandId,
        };
        break;
    }
    try {
      const signed = this.writer.recordCardAttemptEvent({
        key,
        attemptId: input.attemptId,
        staffSignInId,
        event,
      });
      return { state: signed.payload.state };
    } catch (error) {
      return refused(error);
    }
  }
}
