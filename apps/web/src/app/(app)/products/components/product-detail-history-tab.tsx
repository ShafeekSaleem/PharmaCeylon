"use client";

import { useMemo, useState } from "react";
import {
  IconActivity,
  IconAlertTriangle,
  IconBox,
  IconDollarSign,
  IconEdit,
  IconPackage,
  IconTruck,
} from "@/components/icons";
import { InventoryFilterSelect } from "../../inventory/components/inventory-filter-select";
import detailCss from "../product-detail.module.css";
import type { AuditHistoryItem, ProductDetailTab } from "../types";
import {
  formatAuditEventName,
  formatDateTime,
  formatHistoryReference,
  formatHistorySummary,
  historyActionLabel,
  historyActivityTone,
  historyEventCategory,
  historyTargetTab,
  type HistoryDatePreset,
  type HistoryFilter,
} from "../utils/format";

const FILTERS: { id: HistoryFilter; label: string }[] = [
  { id: "all", label: "All activity" },
  { id: "product", label: "Product updates" },
  { id: "stock", label: "Stock & batch" },
  { id: "pricing", label: "Pricing" },
];

const DATE_PRESETS: { id: HistoryDatePreset; label: string }[] = [
  { id: "all", label: "All dates" },
  { id: "7", label: "Last 7 days" },
  { id: "30", label: "Last 30 days" },
  { id: "90", label: "Last 90 days" },
];

const ACTIVITY_ICONS: Record<HistoryFilter, typeof IconPackage> = {
  all: IconActivity,
  product: IconEdit,
  stock: IconBox,
  pricing: IconDollarSign,
};

type Props = {
  history: AuditHistoryItem[];
  onSelectTab: (tab: ProductDetailTab) => void;
};

function activityIcon(eventName: string, payload?: unknown) {
  const category = historyEventCategory(eventName, payload);
  const name = eventName.toLowerCase();
  if (name.includes("expir")) return IconAlertTriangle;
  if (name.includes("receipt") || name.includes("purchase")) return IconTruck;
  if (category === "pricing") return IconDollarSign;
  if (category === "stock") return IconBox;
  if (category === "product") return IconEdit;
  return ACTIVITY_ICONS[category];
}

function withinDatePreset(iso: string, preset: HistoryDatePreset): boolean {
  if (preset === "all") return true;
  const days = Number(preset);
  const created = new Date(iso).getTime();
  if (Number.isNaN(created)) return false;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return created >= cutoff;
}

export function ProductDetailHistoryTab({ history, onSelectTab }: Props) {
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const [datePreset, setDatePreset] = useState<HistoryDatePreset>("all");
  const [page, setPage] = useState(1);
  const pageSize = 8;

  const filtered = useMemo(() => {
    return history.filter((item) => {
      if (!withinDatePreset(item.createdAt, datePreset)) return false;
      if (filter === "all") return true;
      return historyEventCategory(item.eventName, item.payload) === filter;
    });
  }, [filter, datePreset, history]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const paged = filtered.slice((page - 1) * pageSize, page * pageSize);

  return (
    <section className={detailCss.section}>
      <div className={detailCss.historyToolbar}>
        <div className={detailCss.filterPills} role="tablist" aria-label="History filters">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={filter === f.id}
              className={`${detailCss.filterPill} ${
                filter === f.id ? detailCss.filterPillActive : ""
              }`}
              onClick={() => {
                setFilter(f.id);
                setPage(1);
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className={detailCss.historyDateFilter}>
          <InventoryFilterSelect
            label="Date range"
            value={datePreset}
            options={DATE_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
            onChange={(value) => {
              setDatePreset(value as HistoryDatePreset);
              setPage(1);
            }}
            portal
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className={detailCss.emptyState}>
          <p className={detailCss.muted}>No activity matches this filter.</p>
        </div>
      ) : (
        <>
          <div className={detailCss.tableWrap}>
            <table className={`${detailCss.dataTable} ${detailCss.stockTable}`}>
              <thead>
                <tr>
                  <th>Date &amp; time</th>
                  <th>Activity</th>
                  <th>Summary</th>
                  <th>Performed by</th>
                  <th>Reference / source</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {paged.map((item) => {
                  const summary = formatHistorySummary(item.eventName, item.payload);
                  const tone = historyActivityTone(item.eventName);
                  const Icon = activityIcon(item.eventName, item.payload);
                  const targetTab = historyTargetTab(item.eventName, item.payload);
                  return (
                    <tr key={item.id}>
                      <td className={detailCss.mutedCell}>{formatDateTime(item.createdAt)}</td>
                      <td>
                        <span className={detailCss.historyActivityCell}>
                          <span
                            className={`${detailCss.historyActivityIcon} ${detailCss[`historyActivityIcon_${tone}`]}`}
                          >
                            <Icon size={13} />
                          </span>
                          {formatAuditEventName(item.eventName)}
                        </span>
                      </td>
                      <td>{summary}</td>
                      <td>{item.actor?.fullName ?? "System"}</td>
                      <td className={detailCss.mutedCell}>
                        {formatHistoryReference(item.eventName, item.payload)}
                      </td>
                      <td className={detailCss.tableActionCell}>
                        <button
                          type="button"
                          className={detailCss.sectionActionBtn}
                          onClick={() => onSelectTab(targetTab)}
                        >
                          {historyActionLabel(item.eventName, item.payload)}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {filtered.length > pageSize && (
            <div className={detailCss.paginationBar}>
              <div className={detailCss.paginationControls}>
                <button
                  type="button"
                  className={detailCss.pageBtn}
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Prev
                </button>
                {Array.from({ length: totalPages }, (_, i) => i + 1).map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`${detailCss.pageBtn} ${page === n ? detailCss.pageBtnActive : ""}`}
                    onClick={() => setPage(n)}
                  >
                    {n}
                  </button>
                ))}
                <button
                  type="button"
                  className={detailCss.pageBtn}
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  Next
                </button>
              </div>
              <span className={detailCss.paginationMeta}>
                Showing {(page - 1) * pageSize + 1} to{" "}
                {Math.min(page * pageSize, filtered.length)} of {filtered.length} entries
              </span>
            </div>
          )}
        </>
      )}
    </section>
  );
}
