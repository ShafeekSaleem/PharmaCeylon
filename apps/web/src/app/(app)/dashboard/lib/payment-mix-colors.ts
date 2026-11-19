/**
 * Payment-mix colours from the pharmacy's chart series (UI1 #205). Credit takes the
 * neutral last series.
 */
export const PAYMENT_MIX_COLORS: Record<string, string> = {
  cash: "var(--pc-chart-1)",
  card: "var(--pc-chart-2)",
  mobile_wallet: "var(--pc-chart-3)",
  bank_transfer: "var(--pc-chart-4)",
  credit: "var(--pc-chart-6)",
};

export const PAYMENT_MIX_FALLBACK_COLOR =
  "color-mix(in srgb, var(--pc-muted-fg) 78%, var(--pc-foreground))";

export function paymentMixColor(method: string): string {
  return PAYMENT_MIX_COLORS[method] ?? PAYMENT_MIX_FALLBACK_COLOR;
}
