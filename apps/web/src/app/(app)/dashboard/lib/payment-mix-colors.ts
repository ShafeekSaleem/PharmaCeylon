/**
 * Cohesive donut / payment-mix palette from PharmaCeylon theme tokens.
 * Teal → cyan → soft mint → sage → slate (no navy/rainbow clashes).
 */
export const PAYMENT_MIX_COLORS: Record<string, string> = {
  cash: "var(--pc-primary)",
  card: "var(--pc-secondary-cyan)",
  mobile_wallet:
    "color-mix(in srgb, var(--pc-primary) 48%, #99f6e4)",
  bank_transfer:
    "color-mix(in srgb, var(--pc-primary-hover) 62%, var(--pc-muted-fg))",
  credit: "var(--pc-muted-fg)",
};

export const PAYMENT_MIX_FALLBACK_COLOR =
  "color-mix(in srgb, var(--pc-muted-fg) 78%, var(--pc-foreground))";

export function paymentMixColor(method: string): string {
  return PAYMENT_MIX_COLORS[method] ?? PAYMENT_MIX_FALLBACK_COLOR;
}
