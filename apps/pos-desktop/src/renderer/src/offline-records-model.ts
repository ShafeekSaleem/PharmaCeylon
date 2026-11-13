import type {
  CardAttemptView,
  CardOutcomeInput,
  OfflineSaleView,
} from "../../shared/ipc-contract";
import { MAX_SALE_NOTE_LENGTH } from "../../shared/ipc-contract";

/**
 * What the offline records screen works out for itself: the wording for each kind of note and each
 * stage of a card payment, which buttons a card payment still offers, and which sales an approved
 * card payment could belong to. Nothing here talks to the main process.
 */

export type NoteCategory =
  | "quantity_error"
  | "payment_uncertain"
  | "customer_dispute"
  | "other";

export const NOTE_CATEGORIES: { value: NoteCategory; label: string; hint: string }[] = [
  { value: "quantity_error", label: "Wrong quantity", hint: "More or fewer packs were handed over than rung up." },
  { value: "payment_uncertain", label: "Not sure the payment went through", hint: "The customer may have paid twice, or not at all." },
  { value: "customer_dispute", label: "Customer disagrees with the sale", hint: "Price, items or change." },
  { value: "other", label: "Something else", hint: "Anything the back office should look at." },
];

export { MAX_SALE_NOTE_LENGTH };

/** The note as it will be saved, or why it can't be yet. Surrounding spaces are never saved. */
export function checkNote(text: string): { ok: true; text: string } | { ok: false; reason: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, reason: "Say what went wrong." };
  if (trimmed.length > MAX_SALE_NOTE_LENGTH)
    return { ok: false, reason: `Keep it under ${MAX_SALE_NOTE_LENGTH} characters.` };
  return { ok: true, text: trimmed };
}

export function saleLabel(sale: OfflineSaleView, formatTime: (date: Date) => string): string {
  const items = `${sale.itemCount} ${sale.itemCount === 1 ? "item" : "items"}`;
  return `${formatTime(new Date(sale.at))} · Rs ${sale.total} · ${items}`;
}

export type CardTone = "warn" | "bad" | "ok" | "neutral";

export type CardStage = {
  title: string;
  detail: string;
  tone: CardTone;
  /** Which of the three answers a person can still give about the card machine. */
  canSay: { approved: boolean; declined: boolean; notSure: boolean };
  /** An approved payment that still has to be matched to the sale it paid for. */
  needsSale: boolean;
};

/** Where a card payment stands, in the words used at the counter. */
export function cardStage(attempt: CardAttemptView): CardStage {
  switch (attempt.state) {
    case "prepared":
      return {
        title: "Charge started, result not recorded",
        detail:
          "Look at what the card machine says about this payment, then record it. Nobody is charged again until it is settled.",
        tone: "warn",
        canSay: { approved: true, declined: true, notSure: true },
        needsSale: false,
      };
    case "uncertain":
      return {
        title: "Not sure if it went through",
        detail:
          "Check the card machine's own records for this payment before anyone is charged again, then record what you find.",
        tone: "bad",
        canSay: { approved: true, declined: true, notSure: false },
        needsSale: false,
      };
    case "approved":
      return {
        title: "Approved, not matched to a sale yet",
        detail:
          "The money was taken. Pick the sale it paid for so the payment is closed.",
        tone: "warn",
        canSay: { approved: false, declined: false, notSure: false },
        needsSale: true,
      };
    case "declined":
      return {
        title: "Declined",
        detail: "No money was taken. A new card payment can be started.",
        tone: "neutral",
        canSay: { approved: false, declined: false, notSure: false },
        needsSale: false,
      };
    case "linked_to_sale":
      return {
        title: "Paid and matched to its sale",
        detail: "Nothing more to do.",
        tone: "ok",
        canSay: { approved: false, declined: false, notSure: false },
        needsSale: false,
      };
  }
}

/** Sales an approved payment could belong to: paid by card, newest first, same total first. */
export function salesForCard(
  attempt: CardAttemptView,
  sales: OfflineSaleView[],
  alreadyPaid: ReadonlySet<string> = new Set(),
): OfflineSaleView[] {
  const candidates = sales.filter((s) => s.paidByCard && !alreadyPaid.has(s.saleCommandId));
  return [
    ...candidates.filter((s) => s.total === attempt.amount),
    ...candidates.filter((s) => s.total !== attempt.amount),
  ];
}

/** The reference and approval code are copied from the card machine's slip, never made up. */
export function approvedOutcome(reference: string, approvalCode: string): CardOutcomeInput | null {
  const ref = reference.trim();
  const code = approvalCode.trim();
  if (!ref || !code || ref.length > 64 || code.length > 32) return null;
  return { kind: "approved", reference: ref, approvalCode: code };
}

export function declinedOutcome(reference: string): CardOutcomeInput | null {
  const ref = reference.trim();
  return !ref || ref.length > 64 ? null : { kind: "declined", reference: ref };
}

/** How many card payments hold up the end of an outage, in a sentence. */
export function unsettledSentence(count: number): string {
  return count === 1
    ? "1 card payment is not settled yet."
    : `${count} card payments are not settled yet.`;
}
