import { Prisma } from "@prisma/client";

/**
 * Packs in, units out.
 *
 * A pharmacy buys cartons and sells tablets. Stock is counted in units everywhere — the ledger,
 * batch totals, FEFO, every report — so packs exist only at the edge where a person types a
 * number. These helpers are that edge, and they are deliberately the only place the conversion
 * happens: doing it inline in a service is how "20 boxes" becomes 20 units on a shelf.
 */

/** A quantity as the buyer expressed it. Exactly one of the two is authoritative. */
export type PackQuantityInput = {
  /** Units per pack for this line. Below 1 is meaningless and is treated as 1. */
  unitsPerPack?: number | null;
  /** Packs, when the line was entered in packs. */
  packs?: number | null;
  /** Units, when the line was entered in units (or as a cross-check alongside packs). */
  units?: number | null;
};

export type PackQuantity = {
  units: number;
  packs: number | null;
  unitsPerPack: number;
};

export function normalizeUnitsPerPack(value: number | null | undefined): number {
  if (!value || !Number.isFinite(value) || value < 1) return 1;
  return Math.floor(value);
}

/**
 * Resolve what was typed into units. Packs win when both are present and disagree — the person
 * chose a pack field, and silently keeping a stale unit total is how an order for 20 boxes
 * turns into an order for 20 tablets.
 */
export function resolveQuantity(input: PackQuantityInput): PackQuantity {
  const unitsPerPack = normalizeUnitsPerPack(input.unitsPerPack);
  const packs =
    input.packs === null || input.packs === undefined ? null : Math.floor(input.packs);

  if (packs !== null) {
    return { units: packs * unitsPerPack, packs, unitsPerPack };
  }
  const units = Math.floor(input.units ?? 0);
  return { units, packs: null, unitsPerPack };
}

/** Units as whole packs plus a remainder, for display: 54 at 24/pack → "2 boxes + 6". */
export function splitIntoPacks(units: number, unitsPerPack: number) {
  const per = normalizeUnitsPerPack(unitsPerPack);
  if (per === 1) return { packs: 0, remainder: units, unitsPerPack: per };
  return { packs: Math.floor(units / per), remainder: units % per, unitsPerPack: per };
}

/** Cost of one unit given a pack price. Rounded to 4dp so a pack of 3 doesn't lose cents. */
export function unitCostFromPack(packCost: Prisma.Decimal, unitsPerPack: number): Prisma.Decimal {
  const per = normalizeUnitsPerPack(unitsPerPack);
  return packCost.div(per).toDecimalPlaces(4);
}

export function packCostFromUnit(unitCost: Prisma.Decimal, unitsPerPack: number): Prisma.Decimal {
  return unitCost.mul(normalizeUnitsPerPack(unitsPerPack)).toDecimalPlaces(2);
}

/**
 * What a unit in this batch really cost once free goods are counted.
 *
 * "Buy 10 get 1 free" is the standard deal here. Valuing the 11 units at the invoiced price
 * overstates stock and flatters nothing — the pharmacy paid for 10 and owns 11, so the honest
 * cost per unit is the money divided by the units that arrived. Rejected units are included:
 * they were billed, and until the supplier issues a credit they are stock the pharmacy paid
 * for.
 */
export function effectiveUnitCost(params: {
  unitCost: Prisma.Decimal;
  paidQty: number;
  freeQty: number;
  rejectedQty?: number;
}): Prisma.Decimal {
  const totalUnits = params.paidQty + params.freeQty + (params.rejectedQty ?? 0);
  if (totalUnits <= 0) return params.unitCost.toDecimalPlaces(2);
  const paidTotal = params.unitCost.mul(params.paidQty + (params.rejectedQty ?? 0));
  return paidTotal.div(totalUnits).toDecimalPlaces(2);
}

/**
 * The most a delivery line may contain before an approver has to accept it.
 *
 * Tolerance is a percentage of the ordered quantity, rounded down, and always allows at least
 * the outstanding quantity itself.
 */
export function maxReceivableQty(outstanding: number, orderedQty: number, tolerancePercent: number) {
  if (!Number.isFinite(tolerancePercent) || tolerancePercent <= 0) return outstanding;
  const allowance = Math.floor((orderedQty * tolerancePercent) / 100);
  return outstanding + allowance;
}

/**
 * How far a billed price has moved from the agreed one, as a percentage.
 *
 * Positive means dearer than agreed. Null when there is nothing to compare against — an order
 * line with no cost, or a free line — because "infinitely more expensive" is not a useful thing
 * to put in front of someone at the receiving door.
 */
export function priceVariancePercent(
  orderedUnitCost: Prisma.Decimal | null | undefined,
  billedUnitCost: Prisma.Decimal,
): number | null {
  if (!orderedUnitCost || orderedUnitCost.lte(0)) return null;
  return Number(
    billedUnitCost.minus(orderedUnitCost).div(orderedUnitCost).mul(100).toDecimalPlaces(2),
  );
}

/**
 * Whether a price rise needs someone senior to accept it.
 *
 * A drop never does — nobody disputes paying less, though it is still recorded. A rise is
 * measured against the tenant's tolerance, which defaults to zero: in a pharmacy the person who
 * signs for the goods is rarely the person who agreed the price.
 */
export function priceRiseNeedsApproval(
  variancePercent: number | null,
  tolerancePercent: number,
): boolean {
  if (variancePercent === null || variancePercent <= 0) return false;
  const tolerance = Number.isFinite(tolerancePercent) ? Math.max(tolerancePercent, 0) : 0;
  return variancePercent > tolerance;
}
