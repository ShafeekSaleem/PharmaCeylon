"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type {
  ReportSyncFreshness,
  ReportSyncFreshnessBranch,
} from "@pharmaceylon/shared";
import { branchTime } from "@/lib/branch-time";
import { fetchOfflineSyncFreshness } from "../lib/fetchers";
import type { Scope } from "../lib/types";
import css from "../reports.module.css";

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/**
 * P5 #51 item 11: each line of the freshness caveat, in a manager's words. Every counter that has
 * sent an offline journal gets its last accepted sync; anything that keeps a total short (a stopped
 * journal, an open stock case, a sale whose stock is pending) gets its own line.
 */
export function freshnessLines(
  freshness: ReportSyncFreshness,
  now: Date = new Date(),
): string[] {
  const named = freshness.branches.length > 1;
  const lines: string[] = [];
  for (const branch of freshness.branches)
    lines.push(...branchLines(branch, named, now));
  return lines;
}

function branchLines(
  branch: ReportSyncFreshnessBranch,
  named: boolean,
  now: Date,
): string[] {
  const at = (t: number) => branchTime(t, branch.timezone, now);
  const lines = branch.counters.map((c) => {
    const who = named
      ? `${branch.branchName} · ${c.terminalLabel}`
      : c.terminalLabel;
    const parts = [
      c.lastAcceptedAt === null
        ? "no offline sales accepted yet"
        : `last synced ${at(c.lastAcceptedAt)}`,
    ];
    const stop = c.stoppedAt;
    if (stop)
      parts.push(
        stop.outcome === "held"
          ? `entry ${stop.sequence} waiting since ${at(stop.since)}; sales after it haven't reached the server yet`
          : `stopped at refused entry ${stop.sequence} since ${at(stop.since)}; sales after it won't reach the server until it is reviewed`,
      );
    if (c.openStockCases > 0)
      parts.push(
        `${plural(c.openStockCases, "stock case", "stock cases")} open`,
      );
    return `${who}${c.current ? "" : " (earlier key or computer)"}: ${parts.join("; ")}.`;
  });
  if (branch.pendingStockSales > 0)
    lines.push(
      `${named ? `${branch.branchName}: ` : ""}${plural(branch.pendingStockSales, "offline sale", "offline sales")} in this range ${
        branch.pendingStockSales === 1 ? "is" : "are"
      } recorded, but stock hasn't posted yet: stock figures don't show those units leaving.`,
    );
  return lines;
}

/** The caveat itself, from an already-loaded freshness read. Nothing to say → nothing shown. */
export function SyncFreshnessCaveat({
  freshness,
  now,
}: {
  freshness: ReportSyncFreshness;
  now?: Date;
}) {
  if (freshness.branches.length === 0) return null;
  const lines = freshnessLines(freshness, now);
  return (
    <div
      role={freshness.complete ? "note" : "status"}
      className={
        freshness.complete
          ? css.syncFreshness
          : `${css.syncFreshness} ${css.syncFreshnessIncomplete}`
      }
    >
      <strong>
        {freshness.complete
          ? "Offline counter sales received so far are all in these figures."
          : "These figures may be incomplete."}
      </strong>
      <ul>
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <span className={css.syncFreshnessFoot}>
        Sales a counter hasn&apos;t sent yet aren&apos;t in any report.{" "}
        <Link href="/settings/counters">Counters</Link>
      </span>
    </div>
  );
}

/** Loads and shows the caveat for one sales or stock report. A failed read shows nothing: the
 * caveat never blocks a report. */
export function SyncFreshnessNotice({
  days,
  scope,
  isOwner,
  everyBranch = false,
}: {
  days: number;
  scope: Scope;
  isOwner: boolean;
  /** Branch Sales/Profitability: every branch, whatever the scope filter says. */
  everyBranch?: boolean;
}) {
  const [freshness, setFreshness] = useState<ReportSyncFreshness | null>(null);
  useEffect(() => {
    let live = true;
    setFreshness(null);
    fetchOfflineSyncFreshness(
      days,
      everyBranch
        ? "branches"
        : isOwner && scope === "tenant"
          ? "tenant"
          : null,
    )
      .then((f) => live && setFreshness(f))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [days, scope, isOwner, everyBranch]);
  return freshness ? <SyncFreshnessCaveat freshness={freshness} /> : null;
}
