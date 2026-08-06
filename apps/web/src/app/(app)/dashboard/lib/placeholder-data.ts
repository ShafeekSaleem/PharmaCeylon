/** Explicit placeholder / coming-soon content for AI and unsupported metrics. */

import { PAYMENT_MIX_COLORS } from "./payment-mix-colors";

export type AiInsight = {
  id: string;
  title: string;
  detail: string;
  tone?: "info" | "warning" | "danger" | "success";
  href?: string;
  actionLabel?: string;
};

export const OWNER_AI_INSIGHTS: AiInsight[] = [
  {
    id: "o1",
    title: "Reorder recommendation",
    detail: "Sample: highlight SKUs projected to stock out from sales velocity.",
    tone: "warning",
    href: "/purchasing",
  },
  {
    id: "o2",
    title: "Unusual sales pattern",
    detail: "Sample: flag daypart / category spikes vs your recent baseline.",
    tone: "info",
  },
  {
    id: "o3",
    title: "Margin warning",
    detail: "Sample: call out high-volume lines with margin compression.",
    tone: "danger",
    href: "/reports",
  },
  {
    id: "o4",
    title: "Branch opportunity",
    detail: "Sample: compare branch attach rates once multi-branch marts are ready.",
    tone: "info",
  },
  {
    id: "o5",
    title: "Cash flow note",
    detail:
      "Sample: ageing and settlement workflows will refine credit receivables beyond posted credit tenders.",
    tone: "warning",
  },
];

export const MANAGER_AI_INSIGHTS: AiInsight[] = [
  {
    id: "m1",
    title: "Staffing suggestion",
    detail: "Sample: evening peak staffing tip — schedule module not wired yet.",
    tone: "info",
    actionLabel: "Coming soon",
  },
  {
    id: "m2",
    title: "Replenishment insight",
    detail: "Sample: low-stock SKUs may need PO attention before weekend demand.",
    tone: "success",
    href: "/purchasing",
    actionLabel: "Open purchasing",
  },
  {
    id: "m3",
    title: "Variance alert",
    detail:
      "Sample: compare staff productivity against branch target pace once scheduling lands.",
    tone: "warning",
    href: "/reports",
    actionLabel: "View reports",
  },
  {
    id: "m4",
    title: "Branch comparison",
    detail:
      "Sample: peer branch benchmarking against your assigned target portfolio.",
    tone: "info",
    href: "/reports",
    actionLabel: "View reports",
  },
];

export const PHARMACIST_AI_INSIGHTS: AiInsight[] = [
  {
    id: "p1",
    title: "Therapeutic alternative",
    detail: "Sample: layout preview only — no live therapeutic recommendation engine.",
    tone: "info",
  },
  {
    id: "p2",
    title: "FEFO rotation tip",
    detail: "Sample: illustrative tip. Use Batch & Expiry Monitor for real near-expiry stock.",
    tone: "warning",
    href: "/inventory/batches",
  },
  {
    id: "p3",
    title: "Duplicate therapy",
    detail: "Sample: clinical decision support is not connected yet.",
    tone: "danger",
  },
];

/** Pharmacist: counseling queue — not wired yet. */
export const PLACEHOLDER_COUNSELING = [
  { id: "c1", patient: "Walk-in", topic: "Antibiotic course adherence", priority: "Medium" as const },
  { id: "c2", patient: "A. Fernando", topic: "New inhaler technique", priority: "High" as const },
  { id: "c3", patient: "S. Perera", topic: "Warfarin diet counseling", priority: "High" as const },
];

export const CASHIER_AI_INSIGHTS: AiInsight[] = [
  {
    id: "c1",
    title: "Stock up fast mover",
    detail: "Sample: surface counter SKUs running low once linked to live stock alerts.",
    tone: "warning",
    href: "/inventory?view=low",
    actionLabel: "View low stock",
  },
  {
    id: "c2",
    title: "Verify prescription-required items",
    detail: "Sample: highlight held carts waiting on pharmacist verification.",
    tone: "info",
    href: "/pos",
    actionLabel: "Open POS",
  },
  {
    id: "c3",
    title: "Customer lookup can add value",
    detail: "Sample: link walk-ins to loyalty profiles for refill reminders — CRM not wired.",
    tone: "info",
  },
];

/** Cashier: loyalty / walk-in queue CRM — not wired yet. */
export const PLACEHOLDER_CASHIER_QUEUE = [
  { id: "cq1", name: "Walk-in · Counter", wait: "2 min", status: "Serving" as const },
  { id: "cq2", name: "A. Perera", wait: "5 min", status: "Waiting" as const },
  { id: "cq3", name: "Loyalty · S. Fernando", wait: "8 min", status: "Waiting" as const },
];

export const INVENTORY_AI_INSIGHTS: AiInsight[] = [
  {
    id: "i1",
    title: "FEFO rotation",
    detail: "Sample: prioritize picking near-expiry batches on fast movers.",
    tone: "warning",
    href: "/inventory/batches",
    actionLabel: "Batches",
  },
  {
    id: "i2",
    title: "Dead stock candidate",
    detail: "Sample: slow movers may need return-to-supplier or promo action.",
    tone: "info",
    href: "/inventory?view=low",
    actionLabel: "Stock watch",
  },
  {
    id: "i3",
    title: "PO consolidation",
    detail: "Sample: multiple open POs could be consolidated by supplier — not wired yet.",
    tone: "info",
    href: "/purchasing",
    actionLabel: "Purchasing",
  },
];

export const ANALYST_AI_INSIGHTS: AiInsight[] = [
  {
    id: "an1",
    title: "Demand forecast",
    detail: "Sample: forecast uplift will appear here when analytics marts are wired — not live yet.",
    tone: "info",
    href: "/analytics",
    actionLabel: "Open analytics",
  },
  {
    id: "an2",
    title: "Margin outliers",
    detail: "Sample: SKU margin vs category baselines — layout only.",
    tone: "warning",
    href: "/reports",
    actionLabel: "Open reports",
  },
  {
    id: "an3",
    title: "Seasonality note",
    detail: "Sample: week-over-week anomaly flags from sales history — not wired yet.",
    tone: "info",
  },
];

/** Placeholder payment mix when API lacks aggregated payment analytics. */
export const PLACEHOLDER_PAYMENT_MIX = [
  { label: "Cash", value: 52.1, color: PAYMENT_MIX_COLORS.cash },
  { label: "Card", value: 26.8, color: PAYMENT_MIX_COLORS.card },
  { label: "Mobile Wallet", value: 14.6, color: PAYMENT_MIX_COLORS.mobile_wallet },
  { label: "Credit", value: 6.5, color: PAYMENT_MIX_COLORS.credit },
];

/** Manager: Sales vs Target by department — layout placeholder until targets API ships. */
export const PLACEHOLDER_DEPT_TARGETS = [
  { dept: "Prescription", sales: 485_000, target: 520_000 },
  { dept: "OTC", sales: 312_000, target: 280_000 },
  { dept: "Vitamins", sales: 198_000, target: 210_000 },
  { dept: "Personal Care", sales: 145_000, target: 160_000 },
  { dept: "Devices", sales: 92_000, target: 100_000 },
];

/** Pharmacist: refill / follow-up queue — clinical CRM not wired yet. */
export const PLACEHOLDER_REFILL_FOLLOWUPS = [
  { id: "rf1", patient: "A. Fernando", medicine: "Metformin 500mg", due: "Today", type: "Refill", status: "Due" as const },
  { id: "rf2", patient: "S. Perera", medicine: "Atorvastatin 20mg", due: "Tomorrow", type: "Follow-up", status: "Upcoming" as const },
  { id: "rf3", patient: "N. Silva", medicine: "Amlodipine 5mg", due: "In 3 days", type: "Refill", status: "Upcoming" as const },
  { id: "rf4", patient: "R. Jayasuriya", medicine: "Levothyroxine 50mcg", due: "Today", type: "Follow-up", status: "Due" as const },
];

/** Manager: delayed tasks / customer service issues — ops task board coming soon. */
export const PLACEHOLDER_SERVICE_ISSUES = [
  { id: "si1", label: "Cold-chain temp log overdue", priority: "High" as const },
  { id: "si2", label: "Customer complaint — wrong strength dispensed", priority: "High" as const },
  { id: "si3", label: "Supplier credit note pending review", priority: "Medium" as const },
  { id: "si4", label: "Shelf label reprint for aisle B", priority: "Due" as const },
];
