import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";

/**
 * Sri Lanka–style VAT helper (pilot): exclusive VAT on taxable line base.
 * Rate from `PRICING_VAT_RATE_PERCENT` (default 0 for zero-rated / configurable per deployment).
 *
 * taxableBase = unitPrice * qty - discountAmount (clamped at 0)
 * lineVat = roundHalfUp(taxableBase * rate / 100, 2)
 */
@Injectable()
export class TaxService {
  private readonly vatRatePercent: number;

  constructor(configService: ConfigService) {
    const raw = configService.get<string>("PRICING_VAT_RATE_PERCENT") ?? "0";
    const n = Number.parseFloat(raw);
    this.vatRatePercent = Number.isFinite(n) && n >= 0 && n <= 100 ? n : 0;
  }

  getVatRatePercent(): number {
    return this.vatRatePercent;
  }

  computeLineVatExclusive(unitPrice: Prisma.Decimal, qty: number, discountAmount: Prisma.Decimal): Prisma.Decimal {
    return this.computeLineVatExclusiveAtRate(this.vatRatePercent, unitPrice, qty, discountAmount);
  }

  /** Same computation as `computeLineVatExclusive`, but at an explicit rate — used when a
   *  tenant has set `TenantSettings.vatRatePercent`, overriding the env-configured default. */
  computeLineVatExclusiveAtRate(
    ratePercent: number,
    unitPrice: Prisma.Decimal,
    qty: number,
    discountAmount: Prisma.Decimal,
  ): Prisma.Decimal {
    const base = unitPrice.mul(qty).sub(discountAmount);
    const taxable = base.lt(0) ? new Prisma.Decimal(0) : base;
    if (ratePercent === 0) {
      return new Prisma.Decimal(0);
    }
    const raw = taxable.mul(ratePercent).div(100);
    return raw.toDecimalPlaces(2);
  }
}
