import { Prisma } from "@prisma/client";
import {
  effectiveUnitCost,
  maxReceivableQty,
  normalizeUnitsPerPack,
  packCostFromUnit,
  priceRiseNeedsApproval,
  priceVariancePercent,
  resolveQuantity,
  splitIntoPacks,
  unitCostFromPack,
} from "./pack-math";

const dec = (v: string | number) => new Prisma.Decimal(v);

describe("pack maths", () => {
  describe("normalizeUnitsPerPack", () => {
    it("treats nonsense as singles rather than dividing by zero", () => {
      expect(normalizeUnitsPerPack(null)).toBe(1);
      expect(normalizeUnitsPerPack(0)).toBe(1);
      expect(normalizeUnitsPerPack(-5)).toBe(1);
      expect(normalizeUnitsPerPack(Number.NaN)).toBe(1);
      expect(normalizeUnitsPerPack(24)).toBe(24);
    });
  });

  describe("resolveQuantity", () => {
    it("multiplies packs out into units", () => {
      expect(resolveQuantity({ unitsPerPack: 24, packs: 20 })).toEqual({
        units: 480,
        packs: 20,
        unitsPerPack: 24,
      });
    });

    it("keeps units as typed when no pack was given", () => {
      expect(resolveQuantity({ unitsPerPack: 24, units: 7 })).toEqual({
        units: 7,
        packs: null,
        unitsPerPack: 24,
      });
    });

    it("lets packs win when a stale unit total comes with them", () => {
      // The form sends both; the person chose the pack field. Preferring the units would
      // silently turn an order for 20 boxes into an order for 20 tablets.
      expect(resolveQuantity({ unitsPerPack: 24, packs: 20, units: 20 }).units).toBe(480);
    });
  });

  describe("splitIntoPacks", () => {
    it("reports whole packs and the odd units left over", () => {
      expect(splitIntoPacks(54, 24)).toEqual({ packs: 2, remainder: 6, unitsPerPack: 24 });
    });

    it("leaves singles alone", () => {
      expect(splitIntoPacks(54, 1)).toEqual({ packs: 0, remainder: 54, unitsPerPack: 1 });
    });
  });

  describe("cost conversion", () => {
    it("derives a unit cost from a pack price", () => {
      expect(unitCostFromPack(dec("1200"), 24).toString()).toBe("50");
    });

    it("keeps enough precision for packs that don't divide evenly", () => {
      expect(unitCostFromPack(dec("100"), 3).toString()).toBe("33.3333");
    });

    it("derives a pack price from a unit cost", () => {
      expect(packCostFromUnit(dec("50"), 24).toString()).toBe("1200");
    });
  });

  describe("effectiveUnitCost", () => {
    it("spreads what was paid over the free units too", () => {
      // Buy 10 at 100, get 1 free: 1000 paid for 11 units on the shelf.
      expect(effectiveUnitCost({ unitCost: dec("100"), paidQty: 10, freeQty: 1 }).toString()).toBe(
        "90.91",
      );
    });

    it("leaves the cost alone when nothing is free", () => {
      expect(effectiveUnitCost({ unitCost: dec("45.50"), paidQty: 10, freeQty: 0 }).toString()).toBe(
        "45.5",
      );
    });

    it("counts rejected units as paid for, because they were billed", () => {
      expect(
        effectiveUnitCost({ unitCost: dec("100"), paidQty: 8, freeQty: 0, rejectedQty: 2 }).toString(),
      ).toBe("100");
    });

    it("does not divide by zero when a line is all free goods", () => {
      expect(effectiveUnitCost({ unitCost: dec("100"), paidQty: 0, freeQty: 0 }).toString()).toBe(
        "100",
      );
    });
  });

  describe("priceVariancePercent", () => {
    it("reports how much dearer the bill is than the order", () => {
      expect(priceVariancePercent(dec("120"), dec("140"))).toBe(16.67);
    });

    it("reports a drop as a negative", () => {
      expect(priceVariancePercent(dec("120"), dec("90"))).toBe(-25);
    });

    it("is nothing to report when the price is unchanged", () => {
      expect(priceVariancePercent(dec("120"), dec("120"))).toBe(0);
    });

    it("has nothing to compare against when the order carried no price", () => {
      expect(priceVariancePercent(null, dec("140"))).toBeNull();
      expect(priceVariancePercent(dec("0"), dec("140"))).toBeNull();
    });
  });

  describe("priceRiseNeedsApproval", () => {
    it("sends any rise for approval when the tenant allows none", () => {
      expect(priceRiseNeedsApproval(0.5, 0)).toBe(true);
    });

    it("lets a rise inside the tolerance through", () => {
      expect(priceRiseNeedsApproval(4.9, 5)).toBe(false);
      expect(priceRiseNeedsApproval(5, 5)).toBe(false);
      expect(priceRiseNeedsApproval(5.1, 5)).toBe(true);
    });

    it("never asks anyone to approve paying less", () => {
      expect(priceRiseNeedsApproval(-30, 0)).toBe(false);
    });

    it("stays quiet when there is no comparison to make", () => {
      expect(priceRiseNeedsApproval(null, 0)).toBe(false);
    });
  });

  describe("maxReceivableQty", () => {
    it("allows only the outstanding quantity with no tolerance", () => {
      expect(maxReceivableQty(100, 100, 0)).toBe(100);
    });

    it("adds a percentage of the ordered quantity, rounded down", () => {
      expect(maxReceivableQty(100, 100, 5)).toBe(105);
      expect(maxReceivableQty(40, 100, 2.5)).toBe(42);
    });

    it("measures tolerance against the order, not the remainder", () => {
      // Half the order already arrived; the allowance is still 5% of 100, not of 50.
      expect(maxReceivableQty(50, 100, 5)).toBe(55);
    });
  });
});
