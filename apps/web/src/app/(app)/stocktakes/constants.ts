import type { StocktakeLineFilter, StocktakeScope } from "./types";

export const STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "draft", label: "Draft" },
  { value: "in_progress", label: "In progress" },
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
  full: "All batches with on-hand quantity at this branch",
  cycle: "Same as full — use for partial/cycle counting sessions",
  near_expiry: "Batches expiring within the selected day window",
  quarantined: "Batches currently under quarantine",
  zero_stock: "Batches with zero on-hand (reconciling ghosts)",
  custom: "Start empty and add batches manually",
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
  { value: "uncounted", label: "Uncounted" },
  { value: "variance", label: "Variance" },
  { value: "quarantined", label: "Quarantined" },
  { value: "near_expiry", label: "Near expiry" },
];

export const DEFAULT_NEAR_EXPIRY_DAYS = 90;
export const NEAR_EXPIRY_PRESETS = [30, 90] as const;
