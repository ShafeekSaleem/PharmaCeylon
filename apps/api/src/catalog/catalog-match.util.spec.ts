import {
  looksLikeProductCode,
  scoreMatch,
  stockStatus,
} from "./catalog-match.util";

describe("catalog-match.util", () => {
  const product = {
    sku: "PCL-0001",
    barcode: "8901234567890",
    name: "Amlodipine 5mg Tablets",
    brandName: "AmloCare",
    genericName: "Amlodipine",
    aliases: [{ aliasText: "Amlo 5" }],
  };

  it("ranks exact sku/barcode highest", () => {
    expect(scoreMatch("PCL-0001", product, false)?.matchType).toBe("exact");
    expect(scoreMatch("8901234567890", product, false)?.matchField).toBe("barcode");
  });

  it("looksLikeProductCode detects codes", () => {
    expect(looksLikeProductCode("8901234567890")).toBe(true);
    expect(looksLikeProductCode("PCL-0001")).toBe(true);
    expect(looksLikeProductCode("amlo")).toBe(false);
    expect(looksLikeProductCode("paracetamol tablets")).toBe(false);
  });

  it("exactOnly allows prefix but rejects unrelated terms", () => {
    expect(scoreMatch("Amlodipine 5mg", product, true)?.matchType).toBe("exact");
    expect(scoreMatch("UnrelatedDrug", product, true)).toBeNull();
    expect(scoreMatch("890123", product, true)?.matchType).toBe("exact");
  });

  it("scores generic and alias", () => {
    expect(scoreMatch("Amlodipine", product, false)?.matchType).toBe("generic");
    expect(scoreMatch("Amlo 5", product, false)?.matchType).toBe("alias");
  });

  it("reports barcode for barcode-only includes", () => {
    const p = { ...product, sku: "OTHER", name: "Other", brandName: null, genericName: null, aliases: [] };
    expect(scoreMatch("456789", p, false)?.matchField).toBe("barcode");
  });

  it("stockStatus handles reorder 0", () => {
    expect(stockStatus(0, 0)).toBe("out");
    expect(stockStatus(5, 0)).toBe("healthy");
    expect(stockStatus(3, 5)).toBe("low");
  });
});
