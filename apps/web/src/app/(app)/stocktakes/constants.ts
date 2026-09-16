import type { StocktakeLineFilter, StocktakeScope } from "./types";

export const STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "attention", label: "Needs attention" },
  { value: "active", label: "Active counts" },
  { value: "draft", label: "Draft" },
  { value: "scheduled", label: "Scheduled" },
  { value: "counting", label: "Counting" },
  { value: "submitted", label: "Submitted" },
  { value: "under_review", label: "Awaiting review" },
  { value: "approved", label: "Approved" },
  { value: "posted", label: "Posted" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
] as const;

export const SCOPE_LABELS: Record<StocktakeScope, string> = {
  full: "Full count",
  cycle: "Cycle count",
  near_expiry: "Near expiry",
  quarantined: "Quarantined",
  zero_stock: "Zero stock",
  custom: "Custom",
};

export const SCOPE_DESCRIPTIONS: Record<StocktakeScope, string> = {
  full: "Count every in-scope batch for the selected branch area.",
  cycle: "Count a targeted subset such as categories, shelves, or high-risk items.",
  near_expiry: "Count batches expiring within the selected window.",
  quarantined: "Review batches already held in quarantine.",
  zero_stock: "Look for physical stock where the system currently shows zero.",
  custom: "Start from a hand-picked set of products or batches.",
};

export const SCOPE_OPTIONS: {
  value: StocktakeScope;
  label: string;
  description: string;
}[] = (
  Object.keys(SCOPE_LABELS) as StocktakeScope[]
).map((value) => ({
  value,
  label: SCOPE_LABELS[value],
  description: SCOPE_DESCRIPTIONS[value],
}));

export const LINE_FILTER_OPTIONS: {
  value: StocktakeLineFilter;
  label: string;
}[] = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "variance", label: "Variance" },
  { value: "counted", label: "Counted" },
  { value: "recount", label: "Recount" },
  { value: "quarantined", label: "Quarantined" },
  { value: "near_expiry", label: "Near expiry" },
];

export const DEFAULT_NEAR_EXPIRY_DAYS = 90;
export const NEAR_EXPIRY_PRESETS = [30, 60, 90, 180] as const;

export const CONDITION_OPTIONS = [
  { value: "saleable", label: "Saleable" },
  { value: "damaged", label: "Damaged" },
  { value: "expired", label: "Expired" },
  { value: "quarantined", label: "Quarantined" },
  { value: "opened_pack", label: "Opened / broken pack" },
  { value: "missing_label", label: "Missing label" },
  { value: "temperature_affected", label: "Temperature affected" },
] as const;

export const VARIANCE_REASON_OPTIONS = [
  { value: "unrecorded_sale", label: "Unrecorded sale" },
  { value: "unrecorded_receipt", label: "Unrecorded receipt" },
  { value: "damaged_stock", label: "Damaged stock" },
  { value: "expired_stock", label: "Expired stock" },
  { value: "supplier_shortage", label: "Supplier shortage" },
  { value: "wrong_batch_used", label: "Wrong batch used" },
  { value: "unit_conversion_error", label: "Unit conversion error" },
  { value: "transfer_not_recorded", label: "Transfer not recorded" },
  { value: "return_not_recorded", label: "Return not recorded" },
  { value: "counting_error", label: "Counting error" },
  { value: "suspected_theft_loss", label: "Suspected theft / loss" },
  { value: "other", label: "Other" },
] as const;

/** Preset supervisor actions stored in `reviewResolution` (free-text field). */
export const RESOLUTION_OPTIONS = [
  {
    value: "Accept counted qty and post adjustment",
    label: "Accept & post adjustment",
  },
  {
    value: "Write off / dispose variance",
    label: "Write off / dispose",
  },
  {
    value: "Quarantine affected stock",
    label: "Quarantine stock",
  },
  {
    value: "Confirm shortage / loss",
    label: "Confirm shortage / loss",
  },
  {
    value: "Confirm excess / found stock",
    label: "Confirm excess / found stock",
  },
  {
    value: "Corrected after recount",
    label: "Corrected after recount",
  },
  {
    value: "No ledger change needed",
    label: "No ledger change needed",
  },
] as const;
