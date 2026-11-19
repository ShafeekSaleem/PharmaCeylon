import {
  DISPLAY_LOCALE,
  type DailyWorkItem,
  type DailyWorkKind,
} from "@pharmaceylon/shared";

/**
 * The dashboard queue grouped by what you do next (UI1 #205). Grouping is presentation only: the
 * items, their order inside a group, the counts and who may see what all come from the daily-work
 * source unchanged (W11 #145).
 */
export type WorkGroupKey =
  | "decision"
  | "stock"
  | "receiving"
  | "counts"
  | "counter"
  | "other";

export const WORK_GROUP_TITLES: Record<WorkGroupKey, string> = {
  decision: "Needs your decision",
  stock: "Stock safety",
  receiving: "Receiving and dispatch",
  counts: "Counts and returns",
  counter: "At the counter",
  other: "Other work",
};

const ORDER: WorkGroupKey[] = [
  "decision",
  "stock",
  "receiving",
  "counts",
  "counter",
  "other",
];

const BY_KIND: Partial<Record<DailyWorkKind, WorkGroupKey>> = {
  "batch.expiry_review": "stock",
  "offline_stock_case.review": "stock",
  "offline_stock_case.resolve": "stock",
  "held_adjustment.post": "stock",
  "purchase_order.receive": "receiving",
  "held_delivery.post": "receiving",
  "prepared_receipt.post": "receiving",
  "transfer.ship": "receiving",
  "transfer.receive": "receiving",
  "import_stock.post": "receiving",
  "stocktake.prepare": "counts",
  "stocktake.count": "counts",
  "stocktake.complete": "counts",
  "stocktake.post": "counts",
  "goods_return.draft": "counts",
  "goods_return.complete": "counts",
};

/** One group per item: a decision first, then work waiting at the desktop counter, then by kind. */
export function workGroup(item: DailyWorkItem): WorkGroupKey {
  if (item.approval) return "decision";
  if (item.where === "counter") return "counter";
  return BY_KIND[item.kind] ?? "other";
}

export type WorkGroup = {
  key: WorkGroupKey;
  title: string;
  items: DailyWorkItem[];
};

/** Groups in a fixed order; items keep the order the source sent them in. Empty groups drop out. */
export function groupWorkItems(items: readonly DailyWorkItem[]): WorkGroup[] {
  const buckets = new Map<WorkGroupKey, DailyWorkItem[]>();
  for (const item of items) {
    const key = workGroup(item);
    const list = buckets.get(key);
    if (list) list.push(item);
    else buckets.set(key, [item]);
  }
  return ORDER.filter((key) => buckets.has(key)).map((key) => ({
    key,
    title: WORK_GROUP_TITLES[key],
    items: buckets.get(key)!,
  }));
}

/** How the row's timing reads, and whether it is the one coloured thing on the row. */
export type WorkLateness = { text: string; tone: "late" | "soon" | "none" };

const DAY_MS = 86_400_000;

function dayKey(at: Date, timeZone: string): string {
  return at.toLocaleDateString("en-CA", { timeZone });
}

/**
 * "3 days late", "Due today", "Due tomorrow", "Due 24 Nov", or how long it has waited when it has
 * no deadline. Lateness is counted in the branch's days, not 24-hour periods since the deadline.
 */
export function workLateness(
  item: DailyWorkItem,
  timeZone: string,
  asOf: string,
): WorkLateness {
  const now = new Date(asOf);
  if (!item.dueAt) {
    const mins = Math.max(
      0,
      Math.floor((now.getTime() - new Date(item.createdAt).getTime()) / 60_000),
    );
    if (mins < 60)
      return {
        text: mins < 1 ? "Just now" : `${mins} min waiting`,
        tone: "none",
      };
    const days = Math.floor(mins / 1440);
    if (days < 1)
      return { text: `${Math.floor(mins / 60)} h waiting`, tone: "none" };
    return {
      text: `${days} day${days === 1 ? "" : "s"} waiting`,
      tone: "none",
    };
  }
  const due = new Date(item.dueAt);
  const days = Math.round(
    (Date.parse(dayKey(now, timeZone)) - Date.parse(dayKey(due, timeZone))) /
      DAY_MS,
  );
  if (item.overdue || days > 0) {
    if (days <= 0) return { text: "Late today", tone: "late" };
    return { text: `${days} day${days === 1 ? "" : "s"} late`, tone: "late" };
  }
  if (days === 0) return { text: "Due today", tone: "soon" };
  if (days === -1) return { text: "Due tomorrow", tone: "soon" };
  return {
    text: `Due ${due.toLocaleDateString(DISPLAY_LOCALE, { day: "numeric", month: "short", timeZone })}`,
    tone: "none",
  };
}
