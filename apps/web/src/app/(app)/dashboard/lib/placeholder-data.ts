/** Explicit placeholder / coming-soon content for AI and unsupported metrics. */

import { PAYMENT_MIX_COLORS } from "./payment-mix-colors";

export type AiInsightExample = { label: string; badge?: string; tone?: "positive" | "negative" | "neutral" };

/** Powers the `/insights` hub's category filter capsules. The first four intentionally reuse
 *  the exact `CategoryKey` union from `reports/lib/nav-config.tsx` so report-sourced insights
 *  need no translation; `operations`/`clinical` cover dashboard-only content with no report match. */
export type AiInsightCategory = "sales" | "profitability" | "inventory" | "purchasing" | "operations" | "clinical";

export type AiInsight = {
  id: string;
  title: string;
  detail: string;
  tone?: "info" | "warning" | "danger" | "success";
  category: AiInsightCategory;
  href?: string;
  actionLabel?: string;
  /** Numeric callout shown as a colored pill on the right — e.g. count=37, countLabel="SKUs". */
  count?: number;
  countLabel?: string;
  /** Overrides the `{count} {countLabel}` pill with a literal pre-formatted string — e.g. a
   *  report-sourced insight's already-formatted `countLabel` from the backend. */
  countText?: string;
  /** Up to a few concrete examples (product names, PO numbers, ...) shown as chips under the row. */
  examples?: AiInsightExample[];
};

export const OWNER_AI_INSIGHTS: AiInsight[] = [
  {
    id: "o1",
    title: "Reorder recommendation",
    detail: "SKUs projected to stock out based on recent sales velocity.",
    tone: "warning",
    category: "inventory",
    href: "/purchasing",
  },
  {
    id: "o2",
    title: "Unusual sales pattern",
    detail: "Daypart / category spikes flagged against your recent baseline.",
    tone: "info",
    category: "sales",
  },
  {
    id: "o3",
    title: "Margin warning",
    detail: "High-volume lines showing margin compression this period.",
    tone: "danger",
    category: "profitability",
    href: "/reports?category=profitability&report=margin-by-product",
  },
  {
    id: "o4",
    title: "Branch opportunity",
    detail: "Attach-rate gap between branches worth a closer look.",
    tone: "info",
    category: "sales",
  },
  {
    id: "o5",
    title: "Cash flow note",
    detail: "Ageing receivables trending up — review credit tenders past due.",
    tone: "warning",
    category: "operations",
  },
];

export const MANAGER_AI_INSIGHTS: AiInsight[] = [
  {
    id: "m1",
    title: "Staffing suggestion",
    detail: "Evening peak staffing looks light against typical footfall.",
    tone: "info",
    category: "operations",
  },
  {
    id: "m2",
    title: "Replenishment insight",
    detail: "Low-stock SKUs may need PO attention before weekend demand.",
    tone: "success",
    category: "inventory",
    href: "/purchasing",
    actionLabel: "Open purchasing",
  },
  {
    id: "m3",
    title: "Variance alert",
    detail: "Staff productivity trailing branch target pace this week.",
    tone: "warning",
    category: "sales",
    href: "/reports?category=sales&report=cashier-performance",
    actionLabel: "View reports",
  },
  {
    id: "m4",
    title: "Branch comparison",
    detail: "Peer branch benchmarking against your assigned target portfolio.",
    tone: "info",
    category: "sales",
    href: "/reports?category=sales&report=branch-sales",
    actionLabel: "View reports",
  },
];

export const PHARMACIST_AI_INSIGHTS: AiInsight[] = [
  {
    id: "p1",
    title: "Therapeutic alternative reminder",
    detail: "Check for lower-cost equivalents before dispensing high-cost lines.",
    tone: "info",
    category: "clinical",
  },
  {
    id: "p2",
    title: "FEFO rotation tip",
    detail: "Prioritize picking near-expiry batches — see Batch & Expiry Monitor.",
    tone: "warning",
    category: "inventory",
    href: "/inventory/batches?nearExpiryDays=30",
  },
  {
    id: "p3",
    title: "Duplicate therapy reminder",
    detail: "Review a patient's active prescriptions for overlapping therapeutic classes before dispensing.",
    tone: "info",
    category: "clinical",
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
    category: "inventory",
    href: "/inventory?view=low",
    actionLabel: "View low stock",
  },
  {
    id: "c2",
    title: "Verify prescription-required items",
    detail: "Held carts waiting on pharmacist verification before checkout.",
    tone: "info",
    category: "operations",
    href: "/pos",
    actionLabel: "Open POS",
  },
  {
    id: "c3",
    title: "Customer lookup adds value",
    detail: "Link walk-ins to a loyalty profile to enable refill reminders.",
    tone: "info",
    category: "operations",
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
    category: "inventory",
    href: "/inventory/batches?nearExpiryDays=30",
    actionLabel: "Batches",
  },
  {
    id: "i2",
    title: "Dead stock candidate",
    detail: "Slow movers worth a return-to-supplier or promo push.",
    tone: "info",
    category: "inventory",
    href: "/inventory",
    actionLabel: "Stock watch",
  },
  {
    id: "i3",
    title: "PO consolidation",
    detail: "Multiple open POs to the same supplier could be consolidated.",
    tone: "info",
    category: "purchasing",
    href: "/purchasing",
    actionLabel: "Purchasing",
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
