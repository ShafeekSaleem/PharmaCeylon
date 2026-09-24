import { Prisma, SupplierInvoiceStatus } from "@prisma/client";

/**
 * The arithmetic of what a pharmacy owes a supplier, kept free of the database so it can be
 * tested directly. Everything money-shaped in the ledger service goes through these.
 */

const ZERO = new Prisma.Decimal(0);

export function dec(
  value: Prisma.Decimal.Value | null | undefined,
): Prisma.Decimal {
  if (value === null || value === undefined || value === "") return ZERO;
  return new Prisma.Decimal(value);
}

/** An invoice line as billed, before tax: quantity × price, less the line's discount. */
export function invoiceLineNet(line: {
  qty: number;
  unitCost: Prisma.Decimal.Value;
  discountPercent?: Prisma.Decimal.Value | null;
}): Prisma.Decimal {
  const gross = dec(line.unitCost).mul(line.qty);
  const discount = gross.mul(dec(line.discountPercent)).div(100);
  return gross.minus(discount).toDecimalPlaces(2);
}

/**
 * The invoice's totals. Tax is the figure printed on the supplier's invoice when one is given
 * — the supplier's rounding is the one that will be argued over — and is otherwise worked out
 * from each line's rate.
 */
export function invoiceTotals(params: {
  lines: Array<{
    qty: number;
    unitCost: Prisma.Decimal.Value;
    discountPercent?: Prisma.Decimal.Value | null;
    taxPercent?: Prisma.Decimal.Value | null;
  }>;
  taxAmount?: Prisma.Decimal.Value | null;
  shippingAmount?: Prisma.Decimal.Value | null;
}) {
  let subtotal = ZERO;
  let computedTax = ZERO;
  for (const line of params.lines) {
    const net = invoiceLineNet(line);
    subtotal = subtotal.plus(net);
    computedTax = computedTax.plus(net.mul(dec(line.taxPercent)).div(100));
  }
  const tax =
    params.taxAmount !== null &&
    params.taxAmount !== undefined &&
    params.taxAmount !== ""
      ? dec(params.taxAmount)
      : computedTax;
  const shipping = dec(params.shippingAmount);
  const total = subtotal.plus(tax).plus(shipping);
  return {
    subtotal: subtotal.toDecimalPlaces(2),
    tax: tax.toDecimalPlaces(2),
    shipping: shipping.toDecimalPlaces(2),
    total: total.toDecimalPlaces(2),
  };
}

/** Where an invoice stands given what has been set against it. A voided invoice stays voided. */
export function invoiceStatus(
  current: SupplierInvoiceStatus,
  total: Prisma.Decimal,
  settled: Prisma.Decimal,
): SupplierInvoiceStatus {
  if (current === SupplierInvoiceStatus.voided) return current;
  if (settled.gte(total) && total.gt(0)) return SupplierInvoiceStatus.paid;
  if (settled.gt(0)) return SupplierInvoiceStatus.partial;
  return SupplierInvoiceStatus.open;
}

export type OpenInvoice = {
  id: string;
  dueDate: Date;
  invoiceDate: Date;
  balance: Prisma.Decimal;
};

/**
 * Spread an amount across open invoices, oldest due date first.
 *
 * This is what a pharmacist means by "pay Hemas 50,000": clear the oldest bills first. Returns
 * what could not be placed, so a caller can refuse an amount larger than what is owed rather
 * than silently leaving money floating.
 */
export function allocateOldestFirst(
  amount: Prisma.Decimal,
  invoices: OpenInvoice[],
) {
  const ordered = [...invoices].sort(
    (a, b) =>
      a.dueDate.getTime() - b.dueDate.getTime() ||
      a.invoiceDate.getTime() - b.invoiceDate.getTime() ||
      a.id.localeCompare(b.id),
  );
  let remaining = dec(amount);
  const allocations: Array<{ invoiceId: string; amount: Prisma.Decimal }> = [];
  for (const invoice of ordered) {
    if (remaining.lte(0)) break;
    if (invoice.balance.lte(0)) continue;
    const take = Prisma.Decimal.min(remaining, invoice.balance);
    allocations.push({
      invoiceId: invoice.id,
      amount: take.toDecimalPlaces(2),
    });
    remaining = remaining.minus(take);
  }
  return { allocations, unplaced: remaining.toDecimalPlaces(2) };
}

export type MatchLineStatus =
  | "matched"
  | "billed_more_than_received"
  | "billed_less_than_received"
  | "price_differs"
  | "billed_not_received"
  | "received_not_billed";

export type MatchLine = {
  productId: string | null;
  product: string;
  orderedQty: number;
  orderedUnitCost: string | null;
  receivedQty: number;
  receivedUnitCost: string | null;
  billedQty: number;
  billedUnitCost: string | null;
  /** Billed minus received, in units. Positive means billed for goods that never arrived. */
  qtyDifference: number;
  /** Billed unit cost minus agreed unit cost. Positive means billed dearer than ordered. */
  priceDifference: string | null;
  /** Money at stake on this line: what was billed beyond what arrived at the agreed price. */
  valueAtStake: string;
  status: MatchLineStatus;
};

/**
 * Three-way match: what was ordered, what arrived, what was billed — per product.
 *
 * The point is the pharmacy catching being billed for goods that never came, or at a price
 * nobody agreed. Received counts rejected units too: they arrived and were billed, and until
 * a debit note is raised against them they are owed for.
 */
export function threeWayMatch(params: {
  ordered: Array<{
    productId: string;
    product: string;
    qty: number;
    unitCost: Prisma.Decimal;
  }>;
  received: Array<{
    productId: string;
    product: string;
    qty: number;
    unitCost: Prisma.Decimal | null;
  }>;
  billed: Array<{
    productId: string | null;
    product: string;
    qty: number;
    unitCost: Prisma.Decimal;
  }>;
}): { lines: MatchLine[]; matched: boolean; valueAtStake: string } {
  type Acc = {
    productId: string | null;
    product: string;
    orderedQty: number;
    orderedValue: Prisma.Decimal;
    receivedQty: number;
    receivedValue: Prisma.Decimal;
    billedQty: number;
    billedValue: Prisma.Decimal;
  };
  const byKey = new Map<string, Acc>();
  const key = (productId: string | null, product: string) =>
    productId ?? `desc:${product.trim().toLowerCase()}`;
  const acc = (productId: string | null, product: string): Acc => {
    const k = key(productId, product);
    let row = byKey.get(k);
    if (!row) {
      row = {
        productId,
        product,
        orderedQty: 0,
        orderedValue: ZERO,
        receivedQty: 0,
        receivedValue: ZERO,
        billedQty: 0,
        billedValue: ZERO,
      };
      byKey.set(k, row);
    }
    return row;
  };

  for (const line of params.ordered) {
    const row = acc(line.productId, line.product);
    row.orderedQty += line.qty;
    row.orderedValue = row.orderedValue.plus(line.unitCost.mul(line.qty));
  }
  for (const line of params.received) {
    const row = acc(line.productId, line.product);
    row.receivedQty += line.qty;
    row.receivedValue = row.receivedValue.plus(
      (line.unitCost ?? ZERO).mul(line.qty),
    );
  }
  for (const line of params.billed) {
    const row = acc(line.productId, line.product);
    row.billedQty += line.qty;
    row.billedValue = row.billedValue.plus(line.unitCost.mul(line.qty));
  }

  const unit = (value: Prisma.Decimal, qty: number) =>
    qty > 0 ? value.div(qty).toDecimalPlaces(2) : null;

  let totalAtStake = ZERO;
  const lines: MatchLine[] = [...byKey.values()].map((row) => {
    const orderedUnit = unit(row.orderedValue, row.orderedQty);
    const receivedUnit = unit(row.receivedValue, row.receivedQty);
    const billedUnit = unit(row.billedValue, row.billedQty);
    const qtyDifference = row.billedQty - row.receivedQty;
    // Compare against the agreed price where there is one; a delivery booked without an order
    // line falls back to what the delivery recorded.
    const reference = orderedUnit ?? receivedUnit;
    const priceDifference =
      billedUnit && reference
        ? billedUnit.minus(reference).toDecimalPlaces(2)
        : null;

    let status: MatchLineStatus = "matched";
    if (row.billedQty > 0 && row.receivedQty === 0)
      status = "billed_not_received";
    else if (row.billedQty === 0 && row.receivedQty > 0)
      status = "received_not_billed";
    else if (qtyDifference > 0) status = "billed_more_than_received";
    else if (qtyDifference < 0) status = "billed_less_than_received";
    else if (
      priceDifference &&
      priceDifference.abs().gte(new Prisma.Decimal("0.01"))
    )
      status = "price_differs";

    // What would be overpaid if the bill were settled as it stands: units billed beyond what
    // arrived, plus any price above the agreed one on the units that did arrive.
    const extraUnits = Math.max(qtyDifference, 0);
    let atStake = (billedUnit ?? ZERO).mul(extraUnits);
    if (priceDifference && priceDifference.gt(0)) {
      atStake = atStake.plus(
        priceDifference.mul(Math.min(row.billedQty, row.receivedQty)),
      );
    }
    atStake = atStake.toDecimalPlaces(2);
    totalAtStake = totalAtStake.plus(atStake);

    return {
      productId: row.productId,
      product: row.product,
      orderedQty: row.orderedQty,
      orderedUnitCost: orderedUnit?.toFixed(2) ?? null,
      receivedQty: row.receivedQty,
      receivedUnitCost: receivedUnit?.toFixed(2) ?? null,
      billedQty: row.billedQty,
      billedUnitCost: billedUnit?.toFixed(2) ?? null,
      qtyDifference,
      priceDifference: priceDifference?.toFixed(2) ?? null,
      valueAtStake: atStake.toFixed(2),
      status,
    };
  });

  lines.sort((a, b) => a.product.localeCompare(b.product));
  return {
    lines,
    matched: lines.every((line) => line.status === "matched"),
    valueAtStake: totalAtStake.toDecimalPlaces(2).toFixed(2),
  };
}
