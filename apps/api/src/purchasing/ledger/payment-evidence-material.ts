import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { dateKeyToUtc } from "../../common/business-date.util";
import { terminalSigningText } from "@pharmaceylon/shared";

export const EVIDENCED_PAYMENT_OPERATION =
  "POST /api/v1/purchasing/payments/evidenced";
export type EvidencedPayment = {
  supplierId: string;
  paidOn: string;
  amount: string;
  method: "bank_transfer" | "cheque" | "card";
  reference: string;
  notes: string | null;
  allocations: { invoiceId: string; amount: string }[];
};
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function evidenceUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) invalid();
  return value.toLowerCase();
}
function invalid(): never {
  throw new BadRequestException("Invalid payment evidence binding.");
}
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    invalid();
  return value as Record<string, unknown>;
}
function amount(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/.test(value)
  )
    invalid();
  const n = new Prisma.Decimal(value);
  if (!n.isFinite() || n.lte(0)) invalid();
  return n.toFixed(2);
}
export function parseEvidencedPayment(value: unknown): EvidencedPayment {
  const row = exact(value, [
    "supplierId",
    "paidOn",
    "amount",
    "method",
    "reference",
    "notes",
    "allocations",
  ]);
  const supplierId = evidenceUuid(row.supplierId);
  if (typeof row.paidOn !== "string") invalid();
  try {
    dateKeyToUtc(row.paidOn);
  } catch {
    invalid();
  }
  if (!["bank_transfer", "cheque", "card"].includes(row.method as string))
    invalid();
  if (
    typeof row.reference !== "string" ||
    !row.reference.trim() ||
    row.reference.length > 100
  )
    invalid();
  if (
    row.notes !== null &&
    (typeof row.notes !== "string" || row.notes.length > 1000)
  )
    invalid();
  if (
    !Array.isArray(row.allocations) ||
    !row.allocations.length ||
    row.allocations.length > 250
  )
    invalid();
  const seen = new Set<string>();
  const allocations = row.allocations
    .map((value) => {
      const part = exact(value, ["invoiceId", "amount"]);
      const invoiceId = evidenceUuid(part.invoiceId);
      if (seen.has(invoiceId)) invalid();
      seen.add(invoiceId);
      return { invoiceId, amount: amount(part.amount) };
    })
    .sort((a, b) => a.invoiceId.localeCompare(b.invoiceId));
  const total = amount(row.amount);
  if (
    !allocations
      .reduce((sum, part) => sum.plus(part.amount), new Prisma.Decimal(0))
      .equals(total)
  )
    invalid();
  return {
    supplierId,
    paidOn: row.paidOn,
    amount: total,
    method: row.method as EvidencedPayment["method"],
    reference: row.reference.trim(),
    notes: row.notes === null ? null : row.notes.trim() || null,
    allocations,
  };
}
export function parseEvidencedRequest(value: unknown) {
  const body = exact(value, ["evidenceId", "payment"]);
  return {
    evidenceId: evidenceUuid(body.evidenceId),
    payment: parseEvidencedPayment(body.payment),
  };
}
export function evidenceMaterialDigest(value: unknown): string {
  return createHash("sha256")
    .update(
      terminalSigningText("command", {
        kind: "supplier_payment_evidence",
        material: value,
      }),
    )
    .digest("hex");
}
