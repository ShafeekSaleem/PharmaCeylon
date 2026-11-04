import type { Prisma } from "@prisma/client";

/** Material keys in the words a person at the counter uses. Anything else is spelled out. */
const LABELS: Record<string, string> = {
  items: "lines",
  received: "what the order has already received",
  delivery: "the delivery",
  purchaseOrderVersion: "the purchase order",
  purchaseOrderId: "the purchase order",
  payload: "the details",
  qty: "quantity",
  value: "value",
  amount: "amount",
  kind: "kind",
  batchId: "batch",
  productId: "product",
  expectedOn: "expected date",
  fromBranchId: "sending branch",
  toBranchId: "receiving branch",
  refundMethod: "refund method",
  reason: "reason",
  reasonCode: "reason",
  saleId: "sale",
  supplierId: "supplier",
  goodsReceiptId: "goods receipt",
  countedBy: "who counted",
  snapshotAt: "count baseline",
  frozenAt: "count baseline",
  scope: "count scope",
  movementMode: "count mode",
};

const words = (key: string) =>
  LABELS[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();

/** Stable text for a JSON value: key order must not count as a change. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}

const lineId = (line: unknown) =>
  line && typeof line === "object" && typeof (line as { id?: unknown }).id === "string"
    ? (line as { id: string }).id
    : null;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** "lines: 2 changed, 1 added" — matched by line id when the lines have one, else by position. */
function describeLines(label: string, before: unknown[], after: unknown[]): string {
  const keyed = [...before, ...after].every((line) => lineId(line) !== null);
  const key = (line: unknown, index: number) => (keyed ? lineId(line)! : String(index));
  const was = new Map(before.map((line, i) => [key(line, i), canonical(line)]));
  const now = new Map(after.map((line, i) => [key(line, i), canonical(line)]));
  let changed = 0;
  let added = 0;
  let removed = 0;
  for (const [id, text] of now) {
    if (!was.has(id)) added += 1;
    else if (was.get(id) !== text) changed += 1;
  }
  for (const id of was.keys()) if (!now.has(id)) removed += 1;
  const parts = [
    changed && `${plural(changed, "line")} changed`,
    added && `${plural(added, "line")} added`,
    removed && `${plural(removed, "line")} removed`,
  ].filter(Boolean);
  return parts.length ? `${label}: ${parts.join(", ")}` : label;
}

/**
 * What differs between the material an approver signed off and the document as it stands now,
 * one phrase per changed part. The digest already proved they differ; this only says where.
 */
export function describeMaterialChanges(
  approved: Prisma.JsonValue,
  current: Prisma.InputJsonObject,
): string[] {
  const before = (approved && typeof approved === "object" && !Array.isArray(approved) ? approved : {}) as Record<
    string,
    unknown
  >;
  const after = JSON.parse(JSON.stringify(current)) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changes: string[] = [];
  for (const key of keys) {
    if (canonical(before[key]) === canonical(after[key])) continue;
    const was = before[key];
    const now = after[key];
    if (Array.isArray(was) && Array.isArray(now)) changes.push(describeLines(words(key), was, now));
    else if (
      was && now && typeof was === "object" && typeof now === "object" &&
      Array.isArray((was as { lines?: unknown }).lines) && Array.isArray((now as { lines?: unknown }).lines)
    ) {
      // A delivery: its lines, and anything else on it.
      const w = was as Record<string, unknown>;
      const n = now as Record<string, unknown>;
      if (canonical(w.lines) !== canonical(n.lines))
        changes.push(describeLines(`${words(key)} lines`, w.lines as unknown[], n.lines as unknown[]));
      const rest = (o: Record<string, unknown>) => canonical({ ...o, lines: null });
      if (rest(w) !== rest(n)) changes.push(words(key));
    } else changes.push(words(key));
  }
  return [...new Set(changes)];
}
