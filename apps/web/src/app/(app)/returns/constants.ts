export { SUMMARY_PERIOD_OPTIONS } from "../purchasing/constants";

export const STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "draft", label: "Draft" },
  { value: "pending_approval", label: "Pending approval" },
  { value: "awaiting_logistics", label: "Awaiting pickup/dispatch" },
  { value: "in_review", label: "In review" },
  { value: "completed", label: "Completed" },
  { value: "rejected", label: "Rejected" },
  { value: "cancelled", label: "Cancelled" },
] as const;

export const TYPE_OPTIONS = [
  { value: "all", label: "All types" },
  { value: "customer", label: "Customer" },
  { value: "supplier", label: "Supplier" },
] as const;
