export { SUMMARY_PERIOD_OPTIONS } from "../purchasing/constants";

export const STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "requested", label: "Pending approval" },
  { value: "approved", label: "Ready to ship" },
  { value: "in_transit", label: "In transit" },
  { value: "partially_received", label: "Partially received" },
  { value: "received", label: "Completed" },
  { value: "overdue", label: "Overdue" },
  { value: "cancelled", label: "Cancelled" },
  { value: "rejected", label: "Rejected" },
] as const;
