/**
 * Currencies the product can actually render.
 *
 * The web app has no shared currency formatter — the rupee symbol is written as
 * a literal across roughly forty screens, receipts and reports. Until that is
 * replaced by a `formatCurrency` driven by `Tenant.currency`, storing anything
 * but LKR produces documents that state one currency and display another, which
 * is worse than not offering the choice.
 *
 * Onboarding offers only LKR, and this list is the server-side half of that:
 * the UI hiding a control is not enforcement, so a crafted request must be
 * rejected here too.
 *
 * Widening this list is the *last* step of adding multi-currency support, not
 * the first — add the formatter and remove the hardcoded literals before
 * touching it.
 */
export const SUPPORTED_CURRENCIES = ["LKR"] as const;

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export const DEFAULT_CURRENCY: SupportedCurrency = "LKR";
