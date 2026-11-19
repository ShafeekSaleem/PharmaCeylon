"use client";

import { useEffect, useState } from "react";
import type { ReportSyncFreshness } from "@pharmaceylon/shared";
import { apiJson } from "@/lib/auth-client";

/** What "Sales today" says under a zero, and whether it is a warning. */
export type SalesZeroNote = { text: string; warning: boolean };

const NO_SALES: SalesZeroNote = {
  text: "No sales recorded yet today",
  warning: false,
};

function dayKey(at: number | Date, timeZone: string): string {
  return new Date(at).toLocaleDateString("en-CA", { timeZone });
}

/**
 * Why today's sales read zero (UI1 #205). A zero is either a quiet morning or counters that have
 * not reported, and a green "+0.0%" can't tell them apart. The counters' last accepted upload
 * (the same read Reports uses for its freshness caveat) can: a counter that has sent nothing
 * since the branch's day began, or whose upload has stopped, is named.
 */
export function salesZeroNote(
  freshness: ReportSyncFreshness | null,
  now: Date = new Date(),
): SalesZeroNote {
  const branch = freshness?.branches[0];
  if (!branch) return NO_SALES;
  const counters = branch.counters.filter((c) => c.current);
  if (counters.length === 0) return NO_SALES;
  const today = dayKey(now, branch.timezone);
  const stopped = counters.filter((c) => c.stoppedAt);
  if (stopped.length > 0)
    return {
      text:
        stopped.length === 1
          ? `${stopped[0].terminalLabel} has stopped sending sales`
          : `${stopped.length} counters have stopped sending sales`,
      warning: true,
    };
  const quiet = counters.filter(
    (c) =>
      c.lastAcceptedAt === null ||
      dayKey(c.lastAcceptedAt, branch.timezone) !== today,
  );
  if (quiet.length === 0)
    return { text: "Every counter has reported; no sales yet", warning: false };
  return {
    text:
      quiet.length === 1
        ? `${quiet[0].terminalLabel} hasn't sent sales yet today`
        : `${quiet.length} counters haven't sent sales yet today`,
    warning: true,
  };
}

/**
 * Reads the branch's counter freshness only while today's sales are zero, and only for someone who
 * can see reports (the endpoint's own permission). Anything else, or a failed read, says plainly
 * that no sales are recorded yet.
 */
export function useSalesZeroNote(
  branchId: string | null,
  zero: boolean,
  canViewReports: boolean,
  refreshKey: string | null,
): SalesZeroNote {
  const [state, setState] = useState<{
    key: string;
    note: SalesZeroNote;
  } | null>(null);
  const key = `${branchId ?? ""}:${refreshKey ?? ""}`;
  const enabled = Boolean(branchId) && zero && canViewReports;

  useEffect(() => {
    if (!enabled || !branchId) return;
    let cancelled = false;
    apiJson<ReportSyncFreshness>("/reports/offline-sync-freshness?days=1", {
      headers: { "x-branch-id": branchId },
    })
      .then((res) => {
        if (!cancelled) setState({ key, note: salesZeroNote(res) });
      })
      .catch(() => {
        if (!cancelled) setState({ key, note: NO_SALES });
      });
    return () => {
      cancelled = true;
    };
  }, [branchId, enabled, key]);

  return enabled && state?.key === key ? state.note : NO_SALES;
}
