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

/**
 * Why today's sales read zero (UI1 #205). The freshness read is about the counters' **offline**
 * journals: online sales never pass through it, and a counter that has never been offline is not
 * listed. So a counter's last journal entry being old says nothing about today, and a quiet
 * morning must not be flagged. What the read can say is that a counter's offline upload has
 * stopped (`stoppedAt`): sales it made offline are not reaching the server, so a zero here may be
 * missing them. Only that is named; anything else is a plain zero.
 */
export function salesZeroNote(
  freshness: ReportSyncFreshness | null,
): SalesZeroNote {
  const branch = freshness?.branches[0];
  const stopped = (branch?.counters ?? []).filter(
    (c) => c.current && c.stoppedAt,
  );
  if (stopped.length === 0) return NO_SALES;
  return {
    text:
      stopped.length === 1
        ? `${stopped[0].terminalLabel} has offline sales that haven't uploaded`
        : `${stopped.length} counters have offline sales that haven't uploaded`,
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
