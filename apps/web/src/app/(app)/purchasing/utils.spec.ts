import type { CreatePoLine, PurchaseOrderItem } from "./types";
import { poLineUnits, poTotals } from "./utils";

/**
 * A line typed in packs keeps a stale "1" in its units box, so the order footer used to price
 * two cartons as a single unit while the line total right above it showed the real figure.
 * These pin that every money number reads the same quantity.
 */
function packLine(overrides: Partial<CreatePoLine> = {}): CreatePoLine {
  return {
    key: "k1",
    productId: "p1",
    orderMode: "packs",
    orderedPacks: "2",
    orderedQty: "1",
    unitsPerPack: 12,
    packLabel: "Box of 12",
    unitCost: "100",
    discountPercent: "0",
    taxPercent: "18",
    ...overrides,
  };
}

describe("poLineUnits", () => {
  it("multiplies a pack line out", () => {
    expect(poLineUnits(packLine())).toBe(24);
  });

  it("reads the units box when the line is typed in units", () => {
    expect(poLineUnits(packLine({ orderMode: "units", orderedQty: "7" }))).toBe(7);
  });

  it("treats an empty pack count as nothing ordered", () => {
    expect(poLineUnits(packLine({ orderedPacks: "" }))).toBe(0);
  });

  it("takes a server line's quantity as the units it already is", () => {
    const serverLine = {
      id: "i1",
      productId: "p1",
      orderedQty: 480,
      unitCost: "50",
      product: { id: "p1", sku: "SKU", name: "Product" },
    } as PurchaseOrderItem;
    expect(poLineUnits(serverLine)).toBe(480);
  });
});

describe("poTotals", () => {
  it("prices a pack line by its units, not by the units box", () => {
    const totals = poTotals([packLine()]);
    expect(totals.subtotal).toBe(2400);
    expect(totals.taxTotal).toBe(432);
    expect(totals.grandTotal).toBe(2832);
  });

  it("agrees with the line total shown on the row", () => {
    const line = packLine({ orderedPacks: "3", discountPercent: "10" });
    const totals = poTotals([line]);
    const base = poLineUnits(line) * 100;
    const discount = base * 0.1;
    expect(totals.subtotal).toBe(base);
    expect(totals.discountTotal).toBe(discount);
    expect(totals.grandTotal).toBeCloseTo(base - discount + (base - discount) * 0.18, 2);
  });

  it("adds shipping once, on top of the lines", () => {
    expect(poTotals([packLine()], "500").grandTotal).toBe(3332);
  });
});
