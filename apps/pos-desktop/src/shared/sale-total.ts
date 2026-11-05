/**
 * The sale total the counter shows before taking payment, computed the way the server does
 * (`TaxService.computeLineVatExclusiveAtRate`): VAT on each line's price × quantity less its
 * discount, rounded half up to the cent per line. Integer minor units throughout; the rate is held
 * in hundredths of a percent. The server still prices the sale; the receipt shows its figures.
 */
export function lineTaxMinor(baseMinor: number, vatRatePercent: number): number {
  if (baseMinor <= 0 || vatRatePercent <= 0) return 0;
  const rateHundredths = Math.round(vatRatePercent * 100);
  return Math.floor((baseMinor * rateHundredths + 5_000) / 10_000);
}

export function saleTotalMinor(
  lines: { unitPriceMinor: number; qty: number; discountMinor?: number }[],
  vatRatePercent: number,
): { subtotalMinor: number; discountMinor: number; taxMinor: number; totalMinor: number } {
  let subtotalMinor = 0;
  let discountMinor = 0;
  let taxMinor = 0;
  for (const line of lines) {
    const gross = line.unitPriceMinor * line.qty;
    // Never more than the line, as the server refuses: a stale discount can't make a line negative.
    const discount = Math.min(Math.max(0, line.discountMinor ?? 0), gross);
    subtotalMinor += gross;
    discountMinor += discount;
    taxMinor += lineTaxMinor(gross - discount, vatRatePercent);
  }
  return { subtotalMinor, discountMinor, taxMinor, totalMinor: subtotalMinor - discountMinor + taxMinor };
}
