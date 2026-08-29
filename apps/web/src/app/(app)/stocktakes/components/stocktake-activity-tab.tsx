"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  IconCheck,
  IconClipboardList,
  IconDownload,
  IconFileText,
  IconRefresh,
  IconSearch,
  IconTag,
  IconUser,
} from "@/components/icons";
import { InventoryFilterSelect } from "../../inventory/components/inventory-filter-select";
import type { StocktakeListItem } from "../types";
import { PAGE_SIZE } from "../types";
import { formatDateTime } from "../utils";
import { StocktakeTablePager } from "./stocktake-table-pager";
import scss from "../stocktakes.module.css";

type Props = {
  stocktake: StocktakeListItem;
};

type MetricTone = "info" | "success" | "warning" | "accent";

function MetricTile({
  label,
  value,
  icon,
  tone,
}: {
  label: string;
  value: number | string;
  icon: ReactNode;
  tone: MetricTone;
}) {
  const toneClass =
    tone === "success"
      ? scss.metricTileIconSuccess
      : tone === "warning"
        ? scss.metricTileIconWarning
        : tone === "accent"
          ? scss.metricTileIconAccent
          : scss.metricTileIconInfo;

  return (
    <div className={scss.metricTile}>
      <span className={`${scss.metricTileIcon} ${toneClass}`} aria-hidden>
        {icon}
      </span>
      <div className={scss.metricTileBody}>
        <span className={scss.metricTileValue}>{value}</span>
        <span className={scss.metricTileLabel}>{label}</span>
      </div>
    </div>
  );
}

type ActivityItem = NonNullable<StocktakeListItem["activity"]>[number];

function eventLabel(eventName: string): string {
  return eventName.replace(/^stocktake\./, "").replace(/_/g, " ");
}

function actionCode(eventName: string): string {
  const key = eventName.toLowerCase();
  if (key.includes("created")) return "CREATE";
  if (key.includes("posted") || key.includes("complete") || key.includes("approve")) return "POST";
  if (key.includes("recount")) return "RECOUNT";
  if (key.includes("counts_saved") || key.includes("counted")) return "COUNT";
  if (key.includes("note")) return "NOTE";
  if (key.includes("lines_added") || key.includes("added")) return "ADD";
  if (
    key.includes("started") ||
    key.includes("submitted") ||
    key.includes("review") ||
    key.includes("scheduled") ||
    key.includes("updated")
  ) {
    return "UPDATE";
  }
  if (key.includes("cancel")) return "CANCEL";
  return "SYSTEM";
}

function actionTone(eventName: string): string {
  switch (actionCode(eventName)) {
    case "CREATE":
      return scss.actionCreate;
    case "UPDATE":
      return scss.actionUpdate;
    case "COUNT":
      return scss.actionCount;
    case "ADD":
      return scss.actionAdd;
    case "NOTE":
      return scss.actionNote;
    case "RECOUNT":
      return scss.actionRecount;
    case "POST":
      return scss.actionPost;
    case "CANCEL":
      return scss.actionCancel;
    default:
      return scss.actionSystem;
  }
}

function timelineDotTone(eventName: string): string {
  switch (actionCode(eventName)) {
    case "CREATE":
    case "ADD":
    case "POST":
      return scss.timelineDotOk;
    case "RECOUNT":
    case "CANCEL":
      return scss.timelineDotWarn;
    case "COUNT":
    case "UPDATE":
      return scss.timelineDotInfo;
    default:
      return scss.timelineDotMuted;
  }
}

function asRecord(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return {};
}

function formatPayloadValue(value: unknown): string {
  if (value == null || value === "") return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
  try {
    return JSON.stringify(value);
  } catch {
    return "—";
  }
}

function eventDescription(item: ActivityItem, stocktake: StocktakeListItem): string {
  const payload = asRecord(item.payload);
  const name = item.eventName.toLowerCase();
  if (name.includes("created")) {
    return `Stocktake ${stocktake.stocktakeNumber} created${stocktake.blindCount ? " with blind count enabled" : ""}.`;
  }
  if (name.includes("started")) return "Counting started and snapshot quantities were frozen.";
  if (name.includes("submitted")) return "Count submitted for supervisor review.";
  if (name.includes("review_started")) return "Variance review opened.";
  if (name.includes("recount")) {
    const count = Array.isArray(payload.lineIds) ? payload.lineIds.length : null;
    return count
      ? `Recount requested for ${count} line${count === 1 ? "" : "s"}.`
      : "Recount requested on selected lines.";
  }
  if (name.includes("counts_saved")) {
    const count = typeof payload.lineCount === "number" ? payload.lineCount : null;
    return count
      ? `Saved counts on ${count} line${count === 1 ? "" : "s"}.`
      : "Count progress saved.";
  }
  if (name.includes("lines_added")) {
    const count = typeof payload.added === "number" ? payload.added : null;
    return count ? `Added ${count} line${count === 1 ? "" : "s"} to the stocktake.` : "Lines added.";
  }
  if (name.includes("posted")) {
    const count = typeof payload.adjustments === "number" ? payload.adjustments : null;
    return count
      ? `Posted ${count} ledger adjustment${count === 1 ? "" : "s"}.`
      : "Adjustments posted to inventory ledger.";
  }
  if (name.includes("approved")) return "Variance review approved.";
  if (name.includes("completed")) return "Stocktake marked complete.";
  if (name.includes("cancelled")) return "Stocktake cancelled.";
  if (name.includes("scheduled")) return "Stocktake scheduled.";
  return eventLabel(item.eventName);
}

function entityLabel(item: ActivityItem, stocktake: StocktakeListItem): string {
  const name = item.eventName.toLowerCase();
  if (name.includes("lines_added") || name.includes("lines_removed")) return "Lines";
  if (name.includes("counts_saved")) return "Count lines";
  if (name.includes("recount")) return "Recount";
  if (name.includes("posted")) return "Ledger posting";
  if (name.includes("review")) return "Review";
  return stocktake.stocktakeNumber;
}

function oldNewValues(
  item: ActivityItem,
  stocktake: StocktakeListItem,
): { oldValue: string; newValue: string } {
  const payload = asRecord(item.payload);
  const name = item.eventName.toLowerCase();
  if (name.includes("created")) {
    return { oldValue: "—", newValue: stocktake.stocktakeNumber };
  }
  if (name.includes("counts_saved")) {
    return {
      oldValue: "—",
      newValue:
        typeof payload.lineCount === "number"
          ? `Saved: ${payload.lineCount} lines`
          : "Counts saved",
    };
  }
  if (name.includes("recount")) {
    return {
      oldValue: "—",
      newValue: Array.isArray(payload.lineIds)
        ? `Recount: ${payload.lineIds.length} line(s)`
        : "Recount: true",
    };
  }
  if (name.includes("posted")) {
    return {
      oldValue: "—",
      newValue:
        typeof payload.adjustments === "number"
          ? `Adjustments: ${payload.adjustments}`
          : "Posted",
    };
  }
  if (name.includes("cancelled")) {
    return {
      oldValue: formatPayloadValue(payload.previousStatus),
      newValue: "cancelled",
    };
  }
  if (name.includes("lines_added")) {
    return {
      oldValue: "—",
      newValue: typeof payload.added === "number" ? `Added: ${payload.added}` : "Lines added",
    };
  }
  if (Object.keys(payload).length === 0) {
    return { oldValue: "—", newValue: "—" };
  }
  const preferred = ["note", "scheduledFor", "snapshotAt", "fields", "lineCount", "added", "removed"];
  for (const key of preferred) {
    if (key in payload) {
      return { oldValue: "—", newValue: `${key}: ${formatPayloadValue(payload[key])}` };
    }
  }
  const firstKey = Object.keys(payload)[0];
  return { oldValue: "—", newValue: `${firstKey}: ${formatPayloadValue(payload[firstKey])}` };
}

function exportActivityCsv(stocktake: StocktakeListItem, rows: ActivityItem[]) {
  const csvRows = rows.map((item) => {
    const { oldValue, newValue } = oldNewValues(item, stocktake);
    return [
      item.createdAt,
      item.actor?.fullName ?? "System",
      actionCode(item.eventName),
      eventLabel(item.eventName),
      entityLabel(item, stocktake),
      oldValue,
      newValue,
    ];
  });
  const escape = (cell: string) =>
    /[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
  const csv = [
    ["Time", "User", "Action", "Event", "Entity", "Old value", "New value"],
    ...csvRows,
  ]
    .map((r) => r.map(escape).join(","))
    .join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${stocktake.stocktakeNumber}-activity.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function StocktakeActivityTab({ stocktake }: Props) {
  const activity = stocktake.activity ?? [];
  const [search, setSearch] = useState("");
  const [eventFilter, setEventFilter] = useState("all");
  const [userFilter, setUserFilter] = useState("all");
  const [logPage, setLogPage] = useState(1);

  const recountCount = stocktake.lines.filter(
    (line) => line.countStatus === "recount_requested",
  ).length;
  const notesCount = stocktake.lines.filter((line) => (line.note ?? "").trim() !== "").length;
  const auditHref = `/audit?entityName=stocktake&entityId=${encodeURIComponent(stocktake.id)}&entityLabel=${encodeURIComponent(stocktake.stocktakeNumber)}`;

  const eventOptions = useMemo(() => {
    const set = new Set(activity.map((item) => eventLabel(item.eventName)));
    return [
      { value: "all", label: "All events" },
      ...Array.from(set)
        .sort()
        .map((type) => ({ value: type, label: type })),
    ];
  }, [activity]);

  const userOptions = useMemo(() => {
    const set = new Set(activity.map((item) => item.actor?.fullName ?? "System"));
    return [
      { value: "all", label: "All users" },
      ...Array.from(set)
        .sort()
        .map((user) => ({ value: user, label: user })),
    ];
  }, [activity]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return activity.filter((item) => {
      const label = eventLabel(item.eventName);
      const actor = item.actor?.fullName ?? "System";
      if (eventFilter !== "all" && label !== eventFilter) return false;
      if (userFilter !== "all" && actor !== userFilter) return false;
      if (!q) return true;
      const { oldValue, newValue } = oldNewValues(item, stocktake);
      const hay = [
        label,
        actor,
        item.eventName,
        oldValue,
        newValue,
        eventDescription(item, stocktake),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [activity, eventFilter, search, stocktake, userFilter]);

  useEffect(() => {
    setLogPage(1);
  }, [eventFilter, userFilter, search]);

  const pagedLog = useMemo(() => {
    const start = (logPage - 1) * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }, [filtered, logPage]);

  const hasFilters = eventFilter !== "all" || userFilter !== "all" || search.trim() !== "";
  const uniqueUsers = userOptions.length - 1;

  if (activity.length === 0) {
    return (
      <div className={scss.emptyState} role="status">
        <p>No stocktake activity has been recorded yet.</p>
        <p className={scss.hintText}>
          Events appear here as the stocktake progresses. You can also open the{" "}
          <Link href={auditHref} className={scss.inlineLink}>
            full audit log
          </Link>
          .
        </p>
      </div>
    );
  }

  return (
    <div className={scss.activityLayout}>
      <div className={scss.metricTiles}>
        <MetricTile
          label="Lines generated"
          value={stocktake.lineCount}
          icon={<IconFileText size={14} />}
          tone="info"
        />
        <MetricTile
          label="Lines counted"
          value={stocktake.countedLineCount}
          icon={<IconCheck size={14} />}
          tone="success"
        />
        <MetricTile
          label="Recount requests"
          value={recountCount}
          icon={<IconRefresh size={14} />}
          tone="info"
        />
        <MetricTile
          label="Approval pending"
          value={stocktake.status === "submitted" || stocktake.status === "under_review" ? 1 : 0}
          icon={<IconUser size={14} />}
          tone="warning"
        />
        <MetricTile
          label="Notes added"
          value={notesCount}
          icon={<IconTag size={14} />}
          tone="accent"
        />
      </div>

      <div className={scss.activityToolbar}>
        <InventoryFilterSelect
          label="Event type"
          value={eventFilter}
          options={eventOptions}
          onChange={setEventFilter}
          portal
        />
        <InventoryFilterSelect
          label="User"
          value={userFilter}
          options={userOptions}
          onChange={setUserFilter}
          portal
        />
        <div className={scss.activitySearchWrap}>
          <IconSearch size={15} className={scss.activitySearchIcon} />
          <input
            className={scss.activitySearchInput}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search events, users, notes…"
            aria-label="Search activity"
          />
        </div>
        {hasFilters ? (
          <button
            type="button"
            className={scss.resetLink}
            onClick={() => {
              setEventFilter("all");
              setUserFilter("all");
              setSearch("");
            }}
          >
            Reset
          </button>
        ) : null}
      </div>

      <div className={scss.activityGrid}>
        <div className={scss.activityFeedCard}>
          <h3 className={scss.sideCardTitle}>Activity timeline</h3>
          {filtered.length === 0 ? (
            <p className={scss.hintText}>No events match the current filters.</p>
          ) : (
            <ol className={scss.activityList}>
              {filtered.map((item, index) => (
                <li key={item.id} className={scss.activityItem}>
                  <span
                    className={`${scss.activityDot} ${timelineDotTone(item.eventName)}`}
                    aria-hidden
                  />
                  {index < filtered.length - 1 ? (
                    <span className={scss.activityLine} aria-hidden />
                  ) : null}
                  <div className={scss.activityBody}>
                    <div className={scss.activityTop}>
                      <span className={scss.activityLabel}>{eventLabel(item.eventName)}</span>
                      <time className={scss.activityMeta} dateTime={item.createdAt}>
                        {formatDateTime(item.createdAt)}
                      </time>
                    </div>
                    <p className={scss.activityDesc}>{eventDescription(item, stocktake)}</p>
                    <span className={scss.activityMeta}>{item.actor?.fullName ?? "System"}</span>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>

        <div className={scss.activityTableCard}>
          <h3 className={scss.sideCardTitle}>Event log</h3>
          <div className={scss.linesTableWrap}>
            <div className={scss.linesTableScroll}>
              <table className={scss.linesTable}>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>User</th>
                    <th>Action</th>
                    <th>Entity</th>
                    <th>Old value</th>
                    <th>New value</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedLog.length === 0 ? (
                    <tr>
                      <td colSpan={6} className={scss.activityMeta}>
                        No events match the current filters.
                      </td>
                    </tr>
                  ) : (
                    pagedLog.map((item) => {
                      const { oldValue, newValue } = oldNewValues(item, stocktake);
                      return (
                        <tr key={`log-${item.id}`}>
                          <td className={scss.activityMeta}>{formatDateTime(item.createdAt)}</td>
                          <td>{item.actor?.fullName ?? "System"}</td>
                          <td>
                            <span className={`${scss.actionPill} ${actionTone(item.eventName)}`}>
                              {actionCode(item.eventName)}
                            </span>
                          </td>
                          <td className={scss.activityMeta}>{entityLabel(item, stocktake)}</td>
                          <td className={scss.activityMeta}>{oldValue}</td>
                          <td className={scss.activityMeta}>{newValue}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            <StocktakeTablePager
              page={logPage}
              pageSize={PAGE_SIZE}
              total={filtered.length}
              onPageChange={setLogPage}
            />
          </div>
        </div>

        <aside className={scss.sidebarCol}>
          <div className={scss.sideCard}>
            <h3 className={scss.sideCardTitle}>Activity summary</h3>
            <div className={scss.sideStatRow}>
              <span>Total events</span>
              <span className={scss.sideStatValue}>{activity.length}</span>
            </div>
            <div className={scss.sideStatRow}>
              <span>Users involved</span>
              <span className={scss.sideStatValue}>{uniqueUsers}</span>
            </div>
            <div className={scss.sideStatRow}>
              <span>Notes added</span>
              <span className={scss.sideStatValue}>{notesCount}</span>
            </div>
            <div className={scss.sideStatRow}>
              <span>Showing</span>
              <span className={scss.sideStatValue}>{filtered.length}</span>
            </div>
            <Link href={auditHref} className={scss.sideActionLink}>
              View full audit log
            </Link>
          </div>
          <div className={scss.sideCard}>
            <h3 className={scss.sideCardTitle}>Export &amp; audit</h3>
            <button
              type="button"
              className={scss.sideActionBtn}
              onClick={() => exportActivityCsv(stocktake, filtered)}
            >
              <IconDownload size={14} />
              Export activity log
            </button>
            <Link href={auditHref} className={scss.sideActionBtnAsLink}>
              <IconClipboardList size={14} />
              Open filtered audit trail
            </Link>
          </div>
        </aside>
      </div>
    </div>
  );
}
