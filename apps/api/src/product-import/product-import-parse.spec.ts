import {
  parseExpiry,
  parseMoney,
  parseQty,
  suggestMapping,
  unmappedHeaders,
} from "./product-import-parse";

/**
 * A customer's export is whatever their old system produced. Everything below is a shape a real
 * pharmacy spreadsheet actually uses — getting any of it wrong silently mis-prices or
 * mis-dates stock, which is far worse than refusing the row.
 */
describe("product import — column mapping suggestions", () => {
  it("claims an explicit cost column before a bare price column can take it", () => {
    const mapping = suggestMapping(["Item Name", "Cost Price", "Price", "Qty"]);

    expect(mapping.costPrice).toBe("Cost Price");
    expect(mapping.sellingPrice).toBe("Price");
    expect(mapping.name).toBe("Item Name");
    expect(mapping.qty).toBe("Qty");
  });

  it("matches headers regardless of case, spacing and punctuation", () => {
    const mapping = suggestMapping(["product_name", "BAR CODE", "pack size", "Expiry Date"]);

    expect(mapping.name).toBe("product_name");
    expect(mapping.barcode).toBe("BAR CODE");
    expect(mapping.packSize).toBe("pack size");
    expect(mapping.expiryDate).toBe("Expiry Date");
  });

  it("never maps two fields to the same column", () => {
    const mapping = suggestMapping(["Name", "Price"]);
    const used = Object.values(mapping);

    expect(new Set(used).size).toBe(used.length);
  });

  it("reports headers it could not place, so nothing looks silently dropped", () => {
    const headers = ["Name", "Qty", "Shelf location", "Supplier rep"];
    const mapping = suggestMapping(headers);

    expect(unmappedHeaders(headers, mapping)).toEqual([
      "Shelf location",
      "Supplier rep",
    ]);
  });
});

describe("product import — number parsing", () => {
  it("strips currency symbols and thousands separators", () => {
    expect(parseMoney("LKR 1,250.50")).toBe(1250.5);
    expect(parseMoney("545.00")).toBe(545);
    expect(parseMoney("1,250")).toBe(1250);
  });

  it("does not read a currency abbreviation's full stop as a decimal point", () => {
    // "Rs. 410" once parsed as 0.41 — a price off by a factor of a thousand, applied silently
    // to every row of an import.
    expect(parseMoney("Rs. 410")).toBe(410);
    expect(parseMoney("Rs.1,250.50")).toBe(1250.5);
    expect(parseQty("Qty. 240")).toBe(240);
  });

  it("reads European separators, where the comma is the decimal point", () => {
    expect(parseMoney("1.250,50")).toBe(1250.5);
    expect(parseMoney("410,50")).toBe(410.5);
  });

  it("rejects text that isn't a number rather than silently reading it as zero", () => {
    expect(parseMoney("n/a")).toBeNull();
    expect(parseMoney("")).toBeNull();
    expect(parseQty("about ten")).toBeNull();
  });

  it("truncates fractional quantities — stock is whole units", () => {
    expect(parseQty("240")).toBe(240);
    expect(parseQty("12.9")).toBe(12);
  });
});

describe("product import — expiry parsing", () => {
  function iso(d: Date | null): string | null {
    return d ? d.toISOString().slice(0, 10) : null;
  }

  it("reads ISO dates", () => {
    expect(iso(parseExpiry("2027-04-30"))).toBe("2027-04-30");
  });

  it("reads the day-first format used in Sri Lanka", () => {
    expect(iso(parseExpiry("30/04/2027"))).toBe("2027-04-30");
    expect(iso(parseExpiry("05-11-2026"))).toBe("2026-11-05");
  });

  it("treats a month/year label as the last day of that month, which is what it means", () => {
    // Batch expiry is very often printed as just the month — "03/2027" means stock is good
    // through the end of March, so reading it as the 1st would expire it 30 days early.
    expect(iso(parseExpiry("03/2027"))).toBe("2027-03-31");
    expect(iso(parseExpiry("2027-02"))).toBe("2027-02-28");
  });

  it("expands a two-digit year into the future, never the past", () => {
    expect(iso(parseExpiry("30/04/27"))).toBe("2027-04-30");
  });

  it("falls back to month-first when day-first is impossible", () => {
    expect(iso(parseExpiry("12/25/2027"))).toBe("2027-12-25");
  });

  it("returns null for something it cannot read, so the row is reported not guessed", () => {
    expect(parseExpiry("soon")).toBeNull();
    expect(parseExpiry("13/13/2027")).toBeNull();
    expect(parseExpiry("")).toBeNull();
  });
});
