/**
 * The sale total the counter shows before taking payment, computed the way the server does
 * (`TaxService.computeLineVatExclusiveAtRate`): VAT on each line's price × quantity, rounded half up
 * to the cent per line. Integer minor units throughout; the rate is held in hundredths of a percent.
 * The server still prices the sale; the receipt shows its figures.
 */
export function lineTaxMinor(baseMinor: number, vatRatePercent: number): number {
  if (baseMinor <= 0 || vatRatePercent <= 0) return 0;
  const rateHundredths = Math.round(vatRatePercent * 100);
  return Math.floor((baseMinor * rateHundredths + 5_000) / 10_000);
}

export function saleTotalMinor(
  lines: { unitPriceMinor: number; qty: number }[],
  vatRatePercent: number,
): { subtotalMinor: number; taxMinor: number; totalMinor: number } {
  let subtotalMinor = 0;
  let taxMinor = 0;
  for (const line of lines) {
    const base = line.unitPriceMinor * line.qty;
    subtotalMinor += base;
    taxMinor += lineTaxMinor(base, vatRatePercent);
  }
  return { subtotalMinor, taxMinor, totalMinor: subtotalMinor + taxMinor };
}
