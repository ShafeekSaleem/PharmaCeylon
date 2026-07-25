export const STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "on_hold", label: "On hold" },
  { value: "inactive", label: "Inactive" },
] as const;

export const TYPE_OPTIONS = [
  { value: "all", label: "All types" },
  { value: "distributor", label: "Distributor" },
  { value: "importer", label: "Importer" },
  { value: "manufacturer", label: "Manufacturer" },
  { value: "wholesaler", label: "Wholesaler" },
  { value: "other", label: "Other" },
] as const;

export const PAYMENT_TERMS_OPTIONS = [
  { value: "all", label: "All terms" },
  { value: "7", label: "Net 7" },
  { value: "14", label: "Net 14" },
  { value: "15", label: "Net 15" },
  { value: "21", label: "Net 21" },
  { value: "30", label: "Net 30" },
  { value: "45", label: "Net 45" },
  { value: "60", label: "Net 60" },
] as const;

export const SUMMARY_PERIOD_OPTIONS = [
  { value: "this_week", label: "This week" },
  { value: "this_month", label: "This month" },
  { value: "last_30", label: "Last 30 days" },
  { value: "this_year", label: "This year" },
] as const;

export const SUPPLIER_TYPE_CREATE_OPTIONS = TYPE_OPTIONS.filter((o) => o.value !== "all");

export const SUPPLIER_STATUS_CREATE_OPTIONS = STATUS_OPTIONS.filter((o) => o.value !== "all");
