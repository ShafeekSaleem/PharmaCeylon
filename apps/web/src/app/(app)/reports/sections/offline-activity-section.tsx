"use client";

import { useEffect, useMemo, useState } from "react";
import { IconAlertTriangle, IconCloud, IconCloudOff, IconShoppingCart } from "@/components/icons";
import { StatGrid, StatCard } from "@/components/ui/stat-card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { DISPLAY_LOCALE } from "@pharmaceylon/shared";
import { BarRows, type BarRow } from "../components/bar-rows";
import { ReportSelect } from "../components/report-select";
import { fetchOfflineActivityReport } from "../lib/fetchers";
import type { ExportPayload, OfflineActivityReportResponse, OfflineOutageRow, OnExportData, Scope } from "../lib/types";
import { money } from "./shift-cash-section";
import css from "../reports.module.css";

type Props = { scope: Scope; isOwner: boolean; days: number; onExportData: OnExportData };

const ALL = "all";

/** "45 min", "2 h 5 min", "3 d 4 h"; under a minute reads "<1 min". */
export function duration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "<1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const daysPart = Math.floor(hours / 24);
  return hours % 24 ? `${daysPart} d ${hours % 24} h` : `${daysPart} d`;
}

function when(iso: string | null, timeZone: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(DISPLAY_LOCALE, { timeZone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** "1 entry", "2 entries", "3 batches". */
const plural = (n: number, word: string) =>
  `${n} ${n === 1 ? word : word.endsWith("y") ? `${word.slice(0, -1)}ies` : /(ch|sh|s|x)$/.test(word) ? `${word}es` : `${word}s`}`;

/**
 * W10 #72: every outage a counter worked through in the range, rebuilt from what it signed while
 * offline: how long it was offline (at least until its last entry), what it sold, and how long
 * the entries took to reach the server. Outages with entries still held or refused for review are
 * flagged; so are sales whose stock waits on a stock case.
 */
export function OfflineActivitySection({ scope, isOwner, days, onExportData }: Props) {
  const [data, setData] = useState<OfflineActivityReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [terminalId, setTerminalId] = useState<string>(ALL);
  const [status, setStatus] = useState<string>(ALL);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchOfflineActivityReport(days, scope, isOwner)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load offline activity");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days, scope, isOwner]);

  const timeZone = data?.timeZone ?? "Asia/Colombo";
  const multiBranch = scope === "tenant" || new Set((data?.byCounter ?? []).map((c) => c.branchName)).size > 1;
  const counterName = (label: string, branchName: string) => (multiBranch ? `${label} · ${branchName}` : label);

  const rows = useMemo(
    () =>
      (data?.outages ?? []).filter(
        (o) => (terminalId === ALL || o.terminalId === terminalId) && (status === ALL || o.status === status),
      ),
    [data, terminalId, status],
  );

  const counterRows: BarRow[] = useMemo(
    () =>
      (data?.byCounter ?? []).map((c) => ({
        key: c.terminalId,
        label: counterName(c.label, c.branchName),
        sublabel: [plural(c.outages, "outage"), plural(c.sales, "sale"), c.awaitingReview ? `${c.awaitingReview} awaiting review` : null]
          .filter(Boolean)
          .join(" · "),
        value: c.offlineForMs,
        valueLabel: duration(c.offlineForMs),
        subValue: money(c.salesTotalMinor),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, multiBranch],
  );

  const columns: Column<OfflineOutageRow>[] = [
    {
      key: "started",
      header: "Went offline",
      width: "7.5rem",
      sortable: true,
      getValue: (r) => r.startedAt,
      render: (r) => (
        <>
          {when(r.startedAt, timeZone)}
          <div className={css.mutedcell}>last entry {when(r.lastEntryAt, timeZone)}</div>
        </>
      ),
    },
    {
      key: "counter",
      header: "Counter",
      width: "7rem",
      render: (r) => (
        <>
          {r.counterLabel ?? r.terminalLabel ?? "Unknown counter"}
          <div className={css.mutedcell}>{multiBranch ? r.branchName : r.staff.map((s) => s.name).join(", ")}</div>
        </>
      ),
    },
    {
      key: "offlineFor",
      header: "Offline for",
      align: "right",
      width: "6rem",
      sortable: true,
      getValue: (r) => r.offlineForMs,
      render: (r) => <span data-tooltip="At least: from going offline to the last entry made offline">{duration(r.offlineForMs)}</span>,
    },
    {
      key: "sales",
      header: "Sales",
      align: "right",
      width: "7rem",
      sortable: true,
      getValue: (r) => r.salesTotalMinor,
      render: (r) => (
        <>
          {money(r.salesTotalMinor)}
          <div className={css.mutedcell}>
            {[plural(r.sales, "sale"), r.salesNotHonoured ? `${r.salesNotHonoured} not honoured` : null].filter(Boolean).join(" · ")}
          </div>
        </>
      ),
    },
    {
      key: "sync",
      header: "Time to sync",
      align: "right",
      width: "6.5rem",
      sortable: true,
      getValue: (r) => r.timeToSyncMs ?? Number.MAX_SAFE_INTEGER,
      render: (r) => (
        <>
          {r.timeToSyncMs == null ? <span className={css.mutedcell}>Not yet</span> : duration(r.timeToSyncMs)}
          <div className={css.mutedcell}>{r.lastSyncedAt ? `synced ${when(r.lastSyncedAt, timeZone)}` : ""}</div>
        </>
      ),
    },
    {
      key: "status",
      header: "Status",
      width: "8rem",
      render: (r) => (
        <>
          {r.status === "needs_review" ? (
            <span
              className={`${css.badge2} ${css.badge2Tight} ${css.watch}`}
              data-tooltip="Entries held or refused at sync wait for a manager's review"
            >
              {plural(r.awaitingReview + r.rejected, "entry")} to review
            </span>
          ) : (
            <span className={`${css.badge2} ${css.badge2Tight} ${css.healthy}`}>Synced</span>
          )}
          {r.stockPendingSales ? (
            <div className={css.mutedcell}>{plural(r.stockPendingSales, "sale")} with a stock case</div>
          ) : null}
        </>
      ),
    },
  ];

  useEffect(() => {
    if (!data || data.outages.length === 0) {
      onExportData(null);
      return;
    }
    const minutes = (ms: number | null) => (ms == null ? "" : Math.round(ms / 60_000));
    const payload: ExportPayload = {
      filename: `offline-activity-${days}d.csv`,
      headers: [
        "Offline session",
        "Branch",
        "Counter",
        "Computer",
        "Staff",
        "Went offline",
        "Last entry",
        "Offline for (min)",
        "Entries",
        "Sales",
        "Sales total",
        "Sales not honoured",
        "Shifts opened",
        "Shifts closed",
        "First synced",
        "Last synced",
        "Time to sync (min)",
        "Held for review",
        "Refused",
        "Sales with a stock case",
        "Status",
      ],
      rows: data.outages.map((r) => [
        r.offlineSessionId,
        r.branchName,
        r.counterLabel ?? "",
        r.terminalLabel ?? "",
        r.staff.map((s) => s.name).join("; "),
        r.startedAt,
        r.lastEntryAt,
        minutes(r.offlineForMs),
        r.entries,
        r.sales,
        (r.salesTotalMinor / 100).toFixed(2),
        r.salesNotHonoured,
        r.shiftsOpened,
        r.shiftsClosed,
        r.firstSyncedAt ?? "",
        r.lastSyncedAt ?? "",
        minutes(r.timeToSyncMs),
        r.awaitingReview,
        r.rejected,
        r.stockPendingSales,
        r.status,
      ]),
    };
    onExportData(payload);
    return () => onExportData(null);
  }, [data, days, onExportData]);

  if (error) return <div className={css.errorState}>{error}</div>;

  const kpis = data?.kpis;
  const dash = loading || !kpis;

  return (
    <div>
      <StatGrid columns={4} dense className={css.heroGrid}>
        <StatCard size="sm" showMenu={false}
          title="Outages"
          value={dash ? "…" : String(kpis.outages)}
          subtitle={dash ? "Counters that went offline" : `${plural(kpis.countersAffected, "counter")} affected`}
          icon={<IconCloudOff size={16} />}
          iconTone="warning"
        />
        <StatCard size="sm" showMenu={false}
          title="Time Offline"
          value={dash ? "…" : kpis.outages ? duration(kpis.offlineForMs) : "—"}
          subtitle={dash || !kpis.outages ? "At least, across outages" : `Longest ${duration(kpis.longestOfflineForMs)}`}
          icon={<IconAlertTriangle size={16} />}
          iconTone="danger"
        />
        <StatCard size="sm" showMenu={false}
          title="Sold Offline"
          value={dash ? "…" : money(kpis.salesTotalMinor)}
          subtitle={
            dash
              ? "Recorded from offline sales"
              : [plural(kpis.sales, "sale"), kpis.stockPendingSales ? `${kpis.stockPendingSales} with a stock case` : null].filter(Boolean).join(" · ")
          }
          icon={<IconShoppingCart size={16} />}
          iconTone="primary"
        />
        <StatCard size="sm" showMenu={false}
          title="Time to Sync"
          value={dash ? "…" : duration(kpis.medianTimeToSyncMs)}
          subtitle={
            dash
              ? "Median, last entry to synced"
              : kpis.entriesAwaitingReview
                ? `${plural(kpis.entriesAwaitingReview, "entry")} awaiting review`
                : `Longest ${duration(kpis.longestTimeToSyncMs)}`
          }
          icon={<IconCloud size={16} />}
          iconTone="success"
        />
      </StatGrid>

      <div className={`${css.card} ${css.firstRow} ${css.snugFirstRow}`}>
        <div className={css.cardhead}>
          <div>
            <h3>Time Offline by Counter</h3>
            <p>Which counters drop out, and what they sold while they were down. Pick one to filter the table.</p>
          </div>
        </div>
        <BarRows rows={counterRows} danger pageSize={6} onRowClick={(key) => setTerminalId(key === terminalId ? ALL : key)} activeKey={terminalId === ALL ? null : terminalId} />
      </div>

      <div className={`${css.card} ${css.firstRow}`}>
        <div className={css.cardhead}>
          <div>
            <h3>Outages</h3>
            <p>Every outage that started in this range, newest first.</p>
          </div>
          <div className={css.cardheadFilters}>
            <ReportSelect
              ariaLabel="Status"
              value={status}
              onChange={setStatus}
              options={[
                { value: ALL, label: "All outages" },
                { value: "needs_review", label: "Entries to review" },
                { value: "synced", label: "Fully synced" },
              ]}
            />
            <ReportSelect
              ariaLabel="Counter"
              value={terminalId}
              onChange={setTerminalId}
              options={[{ value: ALL, label: "All counters" }, ...(data?.byCounter ?? []).map((c) => ({ value: c.terminalId, label: counterName(c.label, c.branchName) }))]}
            />
          </div>
        </div>
        <DataTable
          columns={columns}
          data={rows}
          rowKey={(r) => r.key}
          loading={loading}
          pageSize={10}
          emptyTitle={data?.outages.length ? "No outages match these filters" : "No counter went offline in this range"}
          compact
        />
      </div>
    </div>
  );
}
