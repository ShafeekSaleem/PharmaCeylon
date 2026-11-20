import { invoiceNoWhere } from "./invoice-no-search.util";

describe("invoiceNoWhere", () => {
  it("uses contains when not counter-scoped", () => {
    expect(invoiceNoWhere("INV-2610", false)).toEqual({
      invoiceNo: { contains: "INV-2610", mode: "insensitive" },
    });
  });

  it("matches partial, suffix, and padded receipt tails when counter-scoped", () => {
    expect(invoiceNoWhere("C1R-0001", true).OR).toEqual(
      expect.arrayContaining([
        { invoiceNo: { contains: "C1R-0001", mode: "insensitive" } },
        { invoiceNo: { endsWith: "C1R-0001", mode: "insensitive" } },
      ]),
    );
    const short = invoiceNoWhere("186", true).OR as Array<{ invoiceNo: { endsWith: string } }>;
    expect(short).toEqual(
      expect.arrayContaining([
        { invoiceNo: { endsWith: "186", mode: "insensitive" } },
        { invoiceNo: { endsWith: "-000186", mode: "insensitive" } },
      ]),
    );
    const leading = invoiceNoWhere("000186", true).OR as Array<{ invoiceNo: { endsWith: string } }>;
    expect(leading.map((c) => c.invoiceNo.endsWith)).toContain("-000186");
  });
});