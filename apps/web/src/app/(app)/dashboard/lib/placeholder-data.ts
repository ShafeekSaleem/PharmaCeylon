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
    detail: "SKUs projected to stock out based on recent sales velocity.",
    tone: "warning",
    href: "/purchasing",
  },
  {
    id: "o2",
    title: "Unusual sales pattern",
    detail: "Daypart / category spikes flagged against your recent baseline.",
    tone: "info",
  },
  {
    id: "o3",
    title: "Margin warning",
    detail: "High-volume lines showing margin compression this period.",
    tone: "danger",
    href: "/reports",
  },
  {
    id: "o4",
    title: "Branch opportunity",
    detail: "Attach-rate gap between branches worth a closer look.",
    tone: "info",
  },
  {
    id: "o5",
    title: "Cash flow note",
    detail: "Ageing receivables trending up — review credit tenders past due.",
    tone: "warning",
  },
];

export const MANAGER_AI_INSIGHTS: AiInsight[] = [
  {
    id: "m1",
    title: "Staffing suggestion",
    detail: "Evening peak staffing looks light against typical footfall.",
    tone: "info",
  },
  {
    id: "m2",
    title: "Replenishment insight",
    detail: "Low-stock SKUs may need PO attention before weekend demand.",
    tone: "success",
    href: "/purchasing",
    actionLabel: "Open purchasing",
  },
  {
    id: "m3",
    title: "Variance alert",
    detail: "Staff productivity trailing branch target pace this week.",
    tone: "warning",
    href: "/reports",
    actionLabel: "View reports",
  },
  {
    id: "m4",
    title: "Branch comparison",
    detail: "Peer branch benchmarking against your assigned target portfolio.",
    tone: "info",
    href: "/reports",
    actionLabel: "View reports",
  },
];

export const PHARMACIST_AI_INSIGHTS: AiInsight[] = [
  {
    id: "p1",
    title: "Therapeutic alternative reminder",
    detail: "Check for lower-cost equivalents before dispensing high-cost lines.",
    tone: "info",
  },
  {
    id: "p2",
    title: "FEFO rotation tip",
    detail: "Prioritize picking near-expiry batches — see Batch & Expiry Monitor.",
    tone: "warning",
    href: "/inventory/batches",
  },
  {
    id: "p3",
    title: "Duplicate therapy reminder",
    detail: "Review a patient's active prescriptions for overlapping therapeutic classes before dispensing.",
    tone: "info",
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
    detail: "A few counter SKUs are running low — check before your next restock round.",
    tone: "warning",
    href: "/inventory?view=low",
    actionLabel: "View low stock",
  },
  {
    id: "c2",
    title: "Verify prescription-required items",
    detail: "Held carts waiting on pharmacist verification before checkout.",
    tone: "info",
    href: "/pos",
    actionLabel: "Open POS",
  },
  {
    id: "c3",
    title: "Customer lookup adds value",
    detail: "Link walk-ins to a loyalty profile to enable refill reminders.",
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
    detail: "Prioritize picking near-expiry batches on fast movers.",
    tone: "warning",
    href: "/inventory/batches",
    actionLabel: "Batches",
  },
  {
    id: "i2",
    title: "Dead stock candidate",
    detail: "Slow movers worth a return-to-supplier or promo push.",
    tone: "info",
    href: "/inventory?view=low",
    actionLabel: "Stock watch",
  },
  {
    id: "i3",
    title: "PO consolidation",
    detail: "Multiple open POs to the same supplier could be consolidated.",
    tone: "info",
    href: "/purchasing",
    actionLabel: "Purchasing",
  },
];

export const ANALYST_AI_INSIGHTS: AiInsight[] = [
  {
    id: "an1",
    title: "Demand forecast",
    detail: "Category-level demand uplift worth reviewing ahead of next reorder cycle.",
    tone: "info",
    href: "/analytics",
    actionLabel: "Open analytics",
  },
  {
    id: "an2",
    title: "Margin outliers",
    detail: "A handful of SKUs sit well outside their category's margin baseline.",
    tone: "warning",
    href: "/reports",
    actionLabel: "Open reports",
  },
  {
    id: "an3",
    title: "Seasonality note",
    detail: "Week-over-week sales pattern diverges from the recent trend line.",
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
