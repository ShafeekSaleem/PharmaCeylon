/**
 * W10 #72: offline activity. A counter that loses the server keeps selling under its offline
 * grant and signs every entry with the outage it belongs to (`offlineSessionId`, plus
 * `offlineStartedAt`, when the counter went offline). There is no outage row on the server: an
 * outage is the set of journal entries one counter signed under one offline session. This report
 * rebuilds each outage from them — how long the counter was offline, what it sold, and how long the
 * entries took to reach the server — so a manager can see which counters drop out and for how long.
 *
 * The counter does not sign the moment it reconnected, so `offlineForMs` is a lower bound: from
 * going offline to the last entry made offline.
 */

export type OfflineEntryKind = "ordinary_sale" | "shift_open" | "shift_close";

/** One signed journal entry: accepted (it has a receipt) or still waiting on review. */
export type OfflineEntry = Readonly<{
  commandId: string;
  branchId: string;
  terminalId: string;
  offlineSessionId: string;
  offlineStartedAt: Date;
  occurredAt: Date;
  kind: OfflineEntryKind | string;
  /** Sale entries: the signed total. */
  totalMinor: number;
  /** When the server accepted it; null while it waits for review. */
  syncedAt: Date | null;
  /** When the server first received it (the receipt time for an accepted entry). */
  receivedAt: Date;
  /** `held` or `rejected` for an entry waiting on review; null once accepted. */
  review: "held" | "rejected" | null;
  /** The seller, from the offline sign-in the entry cites. */
  staffUserId: string | null;
  /** Sale entries: a sale was recorded from it. */
  saleRecorded: boolean;
  /** Sale entries: a manager settled it as not honoured (no sale, on purpose). */
  notHonoured: boolean;
  /** Its envelope names the outage but not the rest of what was signed; counted, never dropped. */
  unreadable: boolean;
  /** A recorded sale whose stock could not post at sync and waits on a stock case. */
  stockPending: boolean;
}>;

export type OfflineOutageRow = Readonly<{
  /** `terminalId:offlineSessionId`. */
  key: string;
  offlineSessionId: string;
  branchId: string;
  branchName: string;
  terminalId: string;
  terminalLabel: string | null;
  counterLabel: string | null;
  startedAt: string;
  lastEntryAt: string;
  /** From going offline to the last entry made offline (a lower bound on the outage). */
  offlineForMs: number;
  entries: number;
  /** Sales recorded from this outage, and their signed totals. */
  sales: number;
  salesTotalMinor: number;
  /** Sale entries a manager settled as not honoured: no sale was recorded. */
  salesNotHonoured: number;
  /** Accepted sale entries with no sale and no not-honoured settlement: a replay to look into. */
  salesUnaccounted: number;
  /** Entries whose envelope could not be read. */
  unreadable: number;
  shiftsOpened: number;
  shiftsClosed: number;
  /** First and last time an entry of this outage was accepted by the server. */
  firstSyncedAt: string | null;
  lastSyncedAt: string | null;
  /** From the last entry made offline to the server holding all of it; null while any waits. */
  timeToSyncMs: number | null;
  /** From going back online (approximately: the last entry) to the first entry arriving. */
  firstSyncAfterMs: number | null;
  awaitingReview: number;
  rejected: number;
  stockPendingSales: number;
  staff: { id: string; name: string }[];
  status: "synced" | "needs_review";
}>;

export type OfflineActivityCounterRow = Readonly<{
  terminalId: string;
  label: string;
  branchName: string;
  outages: number;
  offlineForMs: number;
  sales: number;
  salesTotalMinor: number;
  awaitingReview: number;
}>;

export type OfflineActivityReportResponse = Readonly<{
  days: number;
  timeZone: string;
  since: string;
  before: string;
  kpis: Readonly<{
    outages: number;
    countersAffected: number;
    offlineForMs: number;
    longestOfflineForMs: number;
    sales: number;
    salesTotalMinor: number;
    salesNotHonoured: number;
    salesUnaccounted: number;
    /** Unreadable entries, including those that could not even be placed in an outage. */
    unreadableEntries: number;
    /** Median and longest time from last offline entry to fully synced, across synced outages. */
    medianTimeToSyncMs: number | null;
    longestTimeToSyncMs: number | null;
    outagesNeedingReview: number;
    entriesAwaitingReview: number;
    stockPendingSales: number;
  }>;
  byCounter: OfflineActivityCounterRow[];
  outages: OfflineOutageRow[];
}>;

export type OfflineActivityContext = Readonly<{
  branchName: (branchId: string) => string;
  terminal: (terminalId: string) => { label: string | null; counterLabel: string | null };
  person: (userId: string) => string;
}>;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** Folds one outage's entries (any order) into its row. */
export function outageRow(entries: readonly OfflineEntry[], ctx: OfflineActivityContext): OfflineOutageRow {
  if (!entries.length) throw new Error("An outage has at least one entry");
  const first = entries[0]!;
  // Every entry of one session signs the same start; take the earliest in case one disagrees.
  const startedAt = new Date(Math.min(...entries.map((e) => e.offlineStartedAt.getTime())));
  const lastEntryAt = new Date(Math.max(...entries.map((e) => e.occurredAt.getTime())));
  const accepted = entries.filter((e) => e.review === null);
  const synced = accepted.map((e) => e.syncedAt!.getTime());
  const firstSyncedAt = synced.length ? new Date(Math.min(...synced)) : null;
  const lastSyncedAt = synced.length ? new Date(Math.max(...synced)) : null;
  const firstReceived = Math.min(...entries.map((e) => e.receivedAt.getTime()));
  const awaitingReview = entries.filter((e) => e.review === "held").length;
  const rejected = entries.filter((e) => e.review === "rejected").length;
  const waiting = awaitingReview + rejected;
  const saleEntries = accepted.filter((e) => e.kind === "ordinary_sale");
  const sales = saleEntries.filter((e) => e.saleRecorded);
  const notHonoured = saleEntries.filter((e) => !e.saleRecorded && e.notHonoured).length;
  const unaccounted = saleEntries.filter((e) => !e.saleRecorded && !e.notHonoured).length;
  const unreadable = entries.filter((e) => e.unreadable).length;
  const staffIds = [...new Set(entries.map((e) => e.staffUserId).filter((id): id is string => !!id))];
  const terminal = ctx.terminal(first.terminalId);
  return {
    key: `${first.terminalId}:${first.offlineSessionId}`,
    offlineSessionId: first.offlineSessionId,
    branchId: first.branchId,
    branchName: ctx.branchName(first.branchId),
    terminalId: first.terminalId,
    terminalLabel: terminal.label,
    counterLabel: terminal.counterLabel,
    startedAt: startedAt.toISOString(),
    lastEntryAt: lastEntryAt.toISOString(),
    offlineForMs: Math.max(0, lastEntryAt.getTime() - startedAt.getTime()),
    entries: entries.length,
    sales: sales.length,
    salesTotalMinor: sales.reduce((acc, e) => acc + e.totalMinor, 0),
    salesNotHonoured: notHonoured,
    salesUnaccounted: unaccounted,
    unreadable,
    shiftsOpened: accepted.filter((e) => e.kind === "shift_open").length,
    shiftsClosed: accepted.filter((e) => e.kind === "shift_close").length,
    firstSyncedAt: iso(firstSyncedAt),
    lastSyncedAt: iso(lastSyncedAt),
    timeToSyncMs: !waiting && lastSyncedAt ? Math.max(0, lastSyncedAt.getTime() - lastEntryAt.getTime()) : null,
    firstSyncAfterMs: Math.max(0, firstReceived - lastEntryAt.getTime()),
    awaitingReview,
    rejected,
    stockPendingSales: sales.filter((e) => e.stockPending).length,
    staff: staffIds.map((id) => ({ id, name: ctx.person(id) })).sort((a, b) => a.name.localeCompare(b.name)),
    status: waiting || unreadable || unaccounted ? "needs_review" : "synced",
  };
}

/**
 * Outages that **started** in the window, newest first. Entries are grouped by counter and
 * offline session; an entry the server holds both accepted and under review counts once, as
 * accepted (the caller drops the review copy).
 */
export function buildOfflineActivityReport(
  entries: readonly OfflineEntry[],
  ctx: OfflineActivityContext,
  meta: { days: number; timeZone: string; since: Date; before: Date },
  /** Unreadable entries that name no outage, counted by when they arrived. */
  unplacedEntries = 0,
): OfflineActivityReportResponse {
  const groups = new Map<string, OfflineEntry[]>();
  for (const e of entries) {
    const key = `${e.terminalId}:${e.offlineSessionId}`;
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }
  const outages = [...groups.values()]
    .map((list) => outageRow(list, ctx))
    .filter((o) => o.startedAt >= meta.since.toISOString() && o.startedAt < meta.before.toISOString())
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.key.localeCompare(b.key));

  const counters = new Map<string, { terminalId: string; label: string; branchName: string; outages: number; offlineForMs: number; sales: number; salesTotalMinor: number; awaitingReview: number }>();
  for (const o of outages) {
    const c = counters.get(o.terminalId) ?? {
      terminalId: o.terminalId,
      label: o.counterLabel ?? o.terminalLabel ?? "Unknown counter",
      branchName: o.branchName,
      outages: 0,
      offlineForMs: 0,
      sales: 0,
      salesTotalMinor: 0,
      awaitingReview: 0,
    };
    c.outages += 1;
    c.offlineForMs += o.offlineForMs;
    c.sales += o.sales;
    c.salesTotalMinor += o.salesTotalMinor;
    c.awaitingReview += o.awaitingReview + o.rejected;
    counters.set(o.terminalId, c);
  }
  const syncTimes = outages.map((o) => o.timeToSyncMs).filter((t): t is number => t !== null);
  const sum = (pick: (o: OfflineOutageRow) => number) => outages.reduce((acc, o) => acc + pick(o), 0);
  return {
    days: meta.days,
    timeZone: meta.timeZone,
    since: meta.since.toISOString(),
    before: meta.before.toISOString(),
    kpis: {
      outages: outages.length,
      countersAffected: counters.size,
      offlineForMs: sum((o) => o.offlineForMs),
      longestOfflineForMs: outages.reduce((acc, o) => Math.max(acc, o.offlineForMs), 0),
      sales: sum((o) => o.sales),
      salesTotalMinor: sum((o) => o.salesTotalMinor),
      salesNotHonoured: sum((o) => o.salesNotHonoured),
      salesUnaccounted: sum((o) => o.salesUnaccounted),
      unreadableEntries: sum((o) => o.unreadable) + unplacedEntries,
      medianTimeToSyncMs: median(syncTimes),
      longestTimeToSyncMs: syncTimes.length ? Math.max(...syncTimes) : null,
      outagesNeedingReview: outages.filter((o) => o.status === "needs_review").length,
      entriesAwaitingReview: sum((o) => o.awaitingReview + o.rejected),
      stockPendingSales: sum((o) => o.stockPendingSales),
    },
    byCounter: [...counters.values()].sort((a, b) => b.offlineForMs - a.offlineForMs || a.label.localeCompare(b.label)),
    outages,
  };
}
