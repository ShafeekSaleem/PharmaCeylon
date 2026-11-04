import type {
  PaymentMethod,
  RefundReason,
  ReturnLine,
  ReturnSale,
} from "../../shared/ipc-contract";
import { minor } from "./sell-model";

export type Disposition = "restock" | "quarantine";

/** What the cashier has chosen for one line: how many come back, and where they go. */
export type Choice = { qty: number; disposition: Disposition };

export const lineKey = (line: Pick<ReturnLine, "productId" | "batchId">) =>
  `${line.productId}:${line.batchId}`;

/** The server's reasons (`REFUND_REASON_LABELS`), in its order. */
export const REASONS: { code: RefundReason; label: string }[] = [
  { code: "wrong_item", label: "Wrong item" },
  { code: "changed_mind", label: "Changed their mind" },
  { code: "damaged", label: "Damaged" },
  { code: "expired", label: "Expired or short-dated" },
  { code: "adverse_reaction", label: "Adverse reaction" },
  { code: "other", label: "Other" },
];

export const METHOD_LABELS: Record<string, string> = {
  cash: "Cash",
  card: "Card",
  mobile_wallet: "Mobile wallet",
  credit: "Credit",
};

/**
 * Medicines that came back from a patient are held for a pharmacist to inspect: the server's
 * default too (`planRefund`), so an untouched line goes where the server would have sent it.
 */
export function defaultDisposition(line: ReturnLine): Disposition {
  return line.isControlled || line.requiresPrescription
    ? "quarantine"
    : "restock";
}

/** Nothing comes back until the cashier says so; each line starts at its default place. */
export function initialChoices(sale: ReturnSale): Record<string, Choice> {
  return Object.fromEntries(
    sale.lines.map((line) => [
      lineKey(line),
      { qty: 0, disposition: defaultDisposition(line) },
    ]),
  );
}

/** Every unit still returnable, as "Return everything" (A) asks. */
export function everything(
  sale: ReturnSale,
  choices: Record<string, Choice>,
): Record<string, Choice> {
  return Object.fromEntries(
    sale.lines.map((line) => {
      const key = lineKey(line);
      const current = choices[key] ?? {
        qty: 0,
        disposition: defaultDisposition(line),
      };
      return [key, { ...current, qty: line.remainingQty }];
    }),
  );
}

/**
 * What the server refunds for `qty` of a line: what the customer paid for the line, shared over
 * the units sold (`refundUnitPrice` × qty). In minor units, unrounded, so a sum of lines rounds
 * once, as the server's total does.
 */
export function lineRefundMinor(line: ReturnLine, qty: number): number {
  if (line.soldQty <= 0 || qty <= 0) return 0;
  return (minor(line.paidTotal) * qty) / line.soldQty;
}

export function refundTotalMinor(
  sale: ReturnSale,
  choices: Record<string, Choice>,
): number {
  return Math.round(
    sale.lines.reduce(
      (sum, line) => sum + lineRefundMinor(line, choices[lineKey(line)]?.qty ?? 0),
      0,
    ),
  );
}

/** The tenant's limit is inclusive: a refund of exactly the limit needs approval too. */
export function overLimit(sale: ReturnSale, totalMinor: number): boolean {
  return (
    sale.refundLimit !== null &&
    totalMinor > 0 &&
    totalMinor >= minor(sale.refundLimit)
  );
}

export type MethodOption = {
  /** Undefined: back the way the sale was paid, which the server works out. */
  method: PaymentMethod | undefined;
  label: string;
  detail: string;
  icon: "credit-card" | "banknote";
};

/**
 * "As paid" first (the default), then cash from the drawer unless the sale was all cash anyway.
 * Card, wallet and credit refunds go back the way they came; only cash is a choice.
 */
export function methodOptions(sale: ReturnSale): MethodOption[] {
  const methods = [...new Set(sale.payments.map((p) => p.method))];
  const cashOnly = methods.length === 1 && methods[0] === "cash";
  const card = sale.payments.find((p) => p.method === "card");
  const asPaid: MethodOption = cashOnly
    ? {
        method: undefined,
        label: "Cash",
        detail: "From the drawer, as paid",
        icon: "banknote",
      }
    : {
        method: undefined,
        label: methods.map((m) => METHOD_LABELS[m] ?? m).join(" + ") || "As paid",
        detail: card?.reference ? `${card.reference}, as paid` : "As paid",
        icon: methods.includes("card") ? "credit-card" : "banknote",
      };
  return cashOnly
    ? [asPaid]
    : [
        asPaid,
        {
          method: "cash",
          label: "Cash",
          detail: "From the drawer",
          icon: "banknote",
        },
      ];
}

/** "Card · Visa •• 4417" for the found-sale card; the methods alone when there's no reference. */
export function paidText(sale: ReturnSale): string {
  return (
    sale.payments
      .map((p) =>
        p.reference && p.method === "card"
          ? `${METHOD_LABELS[p.method]} · ${p.reference}`
          : (METHOD_LABELS[p.method] ?? p.method),
      )
      .filter((v, i, all) => all.indexOf(v) === i)
      .join(" + ") || "—"
  );
}

/** Lines the refund sends, in the sale's order. */
export function refundLines(
  sale: ReturnSale,
  choices: Record<string, Choice>,
) {
  return sale.lines.flatMap((line) => {
    const choice = choices[lineKey(line)];
    return choice && choice.qty > 0
      ? [
          {
            productId: line.productId,
            batchId: line.batchId,
            qty: choice.qty,
            disposition: choice.disposition,
          },
        ]
      : [];
  });
}

/**
 * Sale totals "about" an amount the customer remembers, as the history's min/max: within 5%,
 * and never narrower than Rs 10 either side.
 */
export function aroundAmount(amount: string): { minTotal: string; maxTotal: string } | null {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return null;
  const spread = Math.max(value * 0.05, 10);
  return {
    minTotal: Math.max(value - spread, 0).toFixed(2),
    maxTotal: (value + spread).toFixed(2),
  };
}
