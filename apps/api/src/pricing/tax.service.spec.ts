import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { TaxService } from "./tax.service";

describe("TaxService", () => {
  it("defaults VAT rate to 0 when unset", () => {
    const config = { get: () => undefined } as unknown as ConfigService;
    const tax = new TaxService(config);
    expect(tax.getVatRatePercent()).toBe(0);
    const vat = tax.computeLineVatExclusive(new Prisma.Decimal("100"), 2, new Prisma.Decimal("0"));
    expect(vat.toString()).toBe("0");
  });

  it("computes exclusive VAT rounded to 2 decimal places", () => {
    const config = { get: () => "15" } as unknown as ConfigService;
    const tax = new TaxService(config);
    expect(tax.getVatRatePercent()).toBe(15);
    // 100 * 2 - 10 = 190 taxable; 15% = 28.50
    const vat = tax.computeLineVatExclusive(new Prisma.Decimal("100"), 2, new Prisma.Decimal("10"));
    expect(vat.toFixed(2)).toBe("28.50");
  });

  it("clamps taxable base at zero", () => {
    const config = { get: () => "10" } as unknown as ConfigService;
    const tax = new TaxService(config);
    const vat = tax.computeLineVatExclusive(new Prisma.Decimal("1"), 1, new Prisma.Decimal("100"));
    expect(vat.toString()).toBe("0");
  });
});
