"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/alert";
import {
  IconActivity,
  IconAlertTriangle,
  IconCalendar,
  IconCheck,
  IconChevronRight,
  IconClipboardList,
  IconDownload,
  IconEdit,
  IconEye,
  IconPackage,
  IconPlus,
  IconSearch,
} from "@/components/icons";
import { ActionButton, DataTable, PageHeader, StatCard, StatusBadge, type Column } from "@/components/ui";
import { useAuth } from "@/lib/use-auth";
import { InventoryFilterSelect } from "../inventory/components/inventory-filter-select";
import layoutCss from "../purchasing/purchasing.module.css";
import { CreateStocktakeModal } from "./components/create-stocktake-modal";
import { StocktakeSummaryDrawer } from "./components/stocktake-summary-drawer";
import { STATUS_OPTIONS } from "./constants";
import { useStocktakes } from "./hooks/use-stocktakes";
import scss from "./stocktakes.module.css";
import { PAGE_SIZE, type StocktakeListItem, type StocktakeStatusFilter } from "./types";
import {
  formatDate,
  formatMoney,
  formatSigned,
  hasStocktakeWriteAccess,
  matchesStatusFilter,
  scopeLabel,
  statusLabel,
  stocktakeHref,
} from "./utils";

export default function StocktakesPage() {
  const { user, branchId } = useAuth();
  const canWrite = hasStocktakeWriteAccess(user, branchId);
  const stocktakes = useStocktakes();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StocktakeStatusFilter>("all");
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [selected, setSelected] = useState<StocktakeListItem | null>(null);

  useEffect(() => {
    setPage(1);
  }, [search, statusFilter]);

  const summary = useMemo(() => {
    let draft = 0;
    let scheduled = 0;
    let counting = 0;
    let needsAttention = 0;
    let completed = 0;
    let openVariances = 0;
    for (const row of stocktakes.rows) {
      if (row.status === "draft") draft += 1;
      if (row.status === "scheduled") scheduled += 1;
      if (row.status === "counting") counting += 1;
      if (matchesStatusFilter(row, "attention")) needsAttention += 1;
      openVariances += row.varianceLineCount ?? 0;
      if (row.status === "completed") completed += 1;
    }
    return { draft, scheduled, counting, needsAttention, completed, openVariances };
  }, [stocktakes.rows]);

  const alerts = useMemo(() => {
    const submitted = stocktakes.rows.filter((r) => r.status === "submitted").length;
    const underReview = stocktakes.rows.filter((r) => r.status === "under_review").length;
    const approved = stocktakes.rows.filter((r) => r.status === "approved").length;
    const stalledCounting = stocktakes.rows.filter(
      (r) => r.status === "counting" && r.uncountedLineCount > 0,
    ).length;
    return [
      {
        key: "submitted",
        label: "Awaiting review",
        hint: "Submitted counts need a reviewer",
        count: submitted,
        tone: "info" as const,
      },
      {
        key: "under_review",
        label: "Under review",
        hint: "Variance lines need reason & resolution",
        count: underReview,
        tone: "warning" as const,
      },
      {
        key: "approved",
        label: "Ready to post",
        hint: "Approved, awaiting stock posting",
        count: approved,
        tone: "warning" as const,
      },
      {
        key: "counting",
        label: "Counting incomplete",
        hint: "Lines still pending a count",
        count: stalledCounting,
        tone: "info" as const,
      },
    ].filter((a) => a.count > 0);
  }, [stocktakes.rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return stocktakes.rows.filter((row) => {
      if (!matchesStatusFilter(row, statusFilter)) return false;
      if (!q) return true;
      const hay = [
        row.stocktakeNumber,
        row.title ?? "",
        row.areaLabel ?? "",
        row.notes ?? "",
        row.counter.fullName,
        row.reviewer?.fullName ?? "",
        scopeLabel(row.scope),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [search, statusFilter, stocktakes.rows]);

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    if (filtered.length > 0 && page > totalPages) {
      setPage(totalPages);
    } else if (filtered.length === 0 && page !== 1) {
      setPage(1);
    }
  }, [filtered.length, page]);

  const paged = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }, [filtered, page]);

  const hasActiveFilters = !!search.trim() || statusFilter !== "all";

  function clearFilters() {
    setSearch("");
    setStatusFilter("all");
  }

  function toggleStatus(next: StocktakeStatusFilter) {
    setStatusFilter((prev) => (prev === next ? "all" : next));
  }

  function exportCsv() {
    const header = [
      "Stocktake",
      "Title",
      "Status",
      "Scope",
      "Area",
      "Progress",
      "Lines counted",
      "Total lines",
      "Variance lines",
      "Variance net",
      "Assigned to",
      "Updated",
    ];
    const lines = filtered.map((row) => [
      row.stocktakeNumber,
      row.title ?? "",
      statusLabel(row.status),
      scopeLabel(row.scope),
      row.areaLabel ?? "",
      `${row.progressPct ?? 0}%`,
      String(row.countedLineCount),
      String(row.lineCount),
      row.varianceLineCount == null ? "" : String(row.varianceLineCount),
      row.varianceUnitsNet == null ? "" : formatSigned(row.varianceUnitsNet),
      row.assignments.map((entry) => entry.user.fullName).join("; ") || row.counter.fullName,
      row.updatedAt,
    ]);
    const csv = [header, ...lines]
      .map((cols) => cols.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "stocktakes-export.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  const columns: Column<StocktakeListItem>[] = useMemo(
    () => [
      {
        key: "number",
        header: "Stocktake",
        render: (row) => (
          <div className={scss.productCell}>
            <div className={scss.titleRow}>
              <Link href={stocktakeHref(row.id)} className={scss.stocktakeNo}>
                {row.stocktakeNumber}
              </Link>
              {row.blindCount ? <span className={scss.blindPill}>Blind</span> : null}
            </div>
            <span className={scss.productMeta}>{row.title || scopeLabel(row.scope)}</span>
          </div>
        ),
      },
      {
        key: "status",
        header: "Status",
        width: "130px",
        render: (row) => <StatusBadge status={row.status} label={statusLabel(row.status)} />,
      },
      {
        key: "scope",
        header: "Scope / area",
        render: (row) => (
          <div className={scss.productCell}>
            <span className={scss.scopeBadge}>{scopeLabel(row.scope)}</span>
            <span className={scss.productMeta}>{row.areaLabel || "Branch scope"}</span>
          </div>
        ),
      },
      {
        key: "progress",
        header: "Progress",
        width: "120px",
        render: (row) => {
          const pct = row.progressPct ?? 0;
          const tone =
            pct >= 100 ? layoutCss.progressFillDone : pct > 0 ? layoutCss.progressFillWarn : "";
          return (
            <div className={layoutCss.receivedCell}>
              <span className={layoutCss.receivedMeta}>
                {row.countedLineCount}/{row.lineCount} · {pct}%
              </span>
              <div className={layoutCss.progressTrack} aria-hidden>
                <div
                  className={`${layoutCss.progressFill}${tone ? ` ${tone}` : ""}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        },
      },
      {
        key: "variance",
        header: "Variance",
        render: (row) => {
          if (row.varianceLineCount == null) {
            return (
              <span className={layoutCss.muted}>
                {row.blindCount ? "Hidden (blind)" : "Hidden"}
              </span>
            );
          }
          if (row.varianceLineCount === 0) {
            return <span className={layoutCss.muted}>None</span>;
          }
          const net = row.varianceUnitsNet ?? 0;
          const netClass =
            net > 0 ? scss.variancePos : net < 0 ? scss.varianceNeg : scss.varianceZero;
          return (
            <div className={scss.listVariance}>
              <span>
                {row.varianceLineCount} line{row.varianceLineCount === 1 ? "" : "s"}
              </span>
              <span className={scss.listVarianceMeta}>
                <span className={netClass}>Net {formatSigned(net)}</span>
                {row.varianceValueApprox != null
                  ? ` · ${formatMoney(row.varianceValueApprox)}`
                  : ""}
              </span>
            </div>
          );
        },
      },
      {
        key: "assigned",
        header: "Assigned to",
        render: (row) => {
          const names =
            row.assignments.map((entry) => entry.user.fullName).join(", ") || row.counter.fullName;
          return <span className={layoutCss.muted}>{names || "—"}</span>;
        },
      },
      {
        key: "updated",
        header: "Updated",
        width: "110px",
        render: (row) => <span className={layoutCss.muted}>{formatDate(row.updatedAt)}</span>,
      },
      {
        key: "actions",
        header: "Actions",
        width: "88px",
        align: "right",
        render: (row) => (
          <div className={layoutCss.actionsCell}>
            <button
              type="button"
              className={`${layoutCss.actionIcon} ${layoutCss.actionIconView}`}
              onClick={() => {
                setSelected(row);
                setSummaryOpen(true);
              }}
              aria-label={`View summary for ${row.stocktakeNumber}`}
              data-tooltip="Quick summary"
            >
              <IconEye size={17} />
            </button>
            <Link
              href={stocktakeHref(row.id)}
              className={`${layoutCss.actionIcon} ${layoutCss.actionIconEdit}`}
              aria-label={`Open workspace for ${row.stocktakeNumber}`}
              data-tooltip="Open workspace"
            >
              <IconEdit size={17} />
            </Link>
          </div>
        ),
      },
    ],
    [],
  );

  return (
    <div className={layoutCss.page}>
      <PageHeader
        subtitleOnly
        floatingActions
        description="Schedule branch counts, submit blind counts, review variances, and post approved stocktake adjustments."
        actions={
          canWrite ? (
            <ActionButton icon={<IconPlus size={16} />} onClick={() => setCreateOpen(true)}>
              New stocktake
            </ActionButton>
          ) : null
        }
      />

      {!stocktakes.hasBranch ? (
        <div className={layoutCss.branchNotice}>
          Select a branch in the header to manage stocktakes for that location.
        </div>
      ) : (
        <div className={layoutCss.dashboard}>
        <div className={layoutCss.mainCol}>
          <div className={layoutCss.kpiRow}>
            <StatCard size="sm"
              title="Draft"
              value={summary.draft}
              subtitle="Not scheduled"
              icon={<IconClipboardList size={16} />}
              iconTone="info"
              active={statusFilter === "draft"}
              onClick={() => toggleStatus("draft")}
            />
            <StatCard size="sm"
              title="Scheduled"
              value={summary.scheduled}
              subtitle="Ready to start"
              icon={<IconCalendar size={16} />}
              iconTone="primary"
              active={statusFilter === "scheduled"}
              onClick={() => toggleStatus("scheduled")}
            />
            <StatCard size="sm"
              title="Counting"
              value={summary.counting}
              subtitle="Active counts"
              icon={<IconActivity size={16} />}
              iconTone="warning"
              active={statusFilter === "counting"}
              onClick={() => toggleStatus("counting")}
            />
            <StatCard size="sm"
              title="Needs attention"
              value={summary.needsAttention}
              subtitle="Review queue or unfinished counts"
              icon={<IconAlertTriangle size={16} />}
              iconTone="danger"
              active={statusFilter === "attention"}
              onClick={() => toggleStatus("attention")}
            />
            <StatCard size="sm"
              title="Open variances"
              value={summary.openVariances}
              subtitle="Visible lines only"
              icon={<IconEye size={16} />}
              iconTone="danger"
            />
            <StatCard size="sm"
              title="Completed"
              value={summary.completed}
              subtitle="Posted and closed"
              icon={<IconCheck size={16} />}
              iconTone="success"
              active={statusFilter === "completed"}
              onClick={() => toggleStatus("completed")}
            />
          </div>

          {stocktakes.error ? <Alert variant="error">{stocktakes.error}</Alert> : null}

          <div className={layoutCss.toolbar}>
            <div className={layoutCss.searchWrap}>
              <IconSearch size={15} className={layoutCss.searchIcon} />
              <input
                type="search"
                className={layoutCss.searchInput}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search number, title, area, assignee…"
              />
            </div>
            <InventoryFilterSelect
              label="Status"
              value={statusFilter}
              options={STATUS_OPTIONS}
              onChange={(value) => setStatusFilter(value as StocktakeStatusFilter)}
            />
            <div className={layoutCss.toolbarSpacer} />
            <button
              type="button"
              className={layoutCss.actionBtn}
              onClick={exportCsv}
              data-tooltip="Download filtered stocktakes as CSV"
            >
              <IconDownload size={14} />
              Export
            </button>
          </div>

          {hasActiveFilters ? (
            <div className={layoutCss.activeFilter}>
              <span>
                Filtered stocktakes · {filtered.length} result{filtered.length === 1 ? "" : "s"}
              </span>
              <button
                type="button"
                className={layoutCss.clearFilter}
                onClick={clearFilters}
                data-tooltip="Reset all stocktake filters"
              >
                Clear filter
              </button>
            </div>
          ) : null}

          <DataTable
            columns={columns}
            data={paged}
            rowKey={(row) => row.id}
            loading={stocktakes.loading}
            page={page}
            pageSize={PAGE_SIZE}
            total={filtered.length}
            onPageChange={setPage}
            emptyTitle={hasActiveFilters ? "No stocktakes match your filters" : "No stocktakes found"}
            emptyDescription={
              hasActiveFilters
                ? "Try clearing filters or adjusting your search."
                : canWrite
                  ? "Create a stocktake to start branch-level counting and variance review."
                  : "No stocktakes are available for this branch."
            }
            emptyIcon={<IconClipboardList size={46} />}
            compact
          />
        </div>

        <aside className={layoutCss.sideCol}>
          <div className={layoutCss.sideCard}>
            <h3 className={layoutCss.sideCardTitle}>Stocktake summary</h3>
            <div className={layoutCss.summaryGrid}>
              <div className={layoutCss.summaryRow}>
                <span>Total stocktakes</span>
                <span className={layoutCss.summaryValue}>{stocktakes.rows.length}</span>
              </div>
              <div className={layoutCss.summaryRow}>
                <span>In progress</span>
                <span className={layoutCss.summaryValue}>{summary.counting}</span>
              </div>
              <div className={layoutCss.summaryRow}>
                <span>Needs attention</span>
                <span className={layoutCss.summaryValue}>{summary.needsAttention}</span>
              </div>
              <div className={`${layoutCss.summaryRow} ${layoutCss.summaryHighlight}`}>
                <span>Completed</span>
                <span className={layoutCss.summaryValue}>{summary.completed}</span>
              </div>
            </div>
            <Link href="/inventory/batches" className={layoutCss.sideLink}>
              View inventory batches →
            </Link>
          </div>

          <div className={layoutCss.sideCard}>
            <h3 className={layoutCss.sideCardTitle}>Stocktake alerts</h3>
            {alerts.length === 0 ? (
              <p className={layoutCss.fieldHint}>No stocktake alerts right now.</p>
            ) : (
              <ul className={layoutCss.alertList}>
                {alerts.map((alert) => (
                  <li key={alert.key}>
                    <button
                      type="button"
                      className={layoutCss.alertItem}
                      onClick={() =>
                        toggleStatus(
                          alert.key === "counting"
                            ? "counting"
                            : (alert.key as StocktakeStatusFilter),
                        )
                      }
                    >
                      <div className={layoutCss.alertItemLeft}>
                        <span
                          className={`${layoutCss.alertIcon} ${
                            alert.tone === "warning"
                              ? layoutCss.alertIconWarning
                              : layoutCss.alertIconInfo
                          }`}
                        >
                          <IconAlertTriangle size={12} />
                        </span>
                        <span>
                          <span className={layoutCss.alertText}>{alert.label}</span>
                          <span className={layoutCss.fieldHint} style={{ display: "block" }}>
                            {alert.hint}
                          </span>
                        </span>
                      </div>
                      <span className={layoutCss.alertCount}>{alert.count}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className={layoutCss.sideCard}>
            <h3 className={layoutCss.sideCardTitle}>Quick actions</h3>
            <div className={scss.quickActions}>
              {canWrite ? (
                <button
                  type="button"
                  className={scss.quickAction}
                  onClick={() => setCreateOpen(true)}
                >
                  <IconPlus size={15} />
                  <span>New stocktake</span>
                  <IconChevronRight size={14} />
                </button>
              ) : null}
              <button
                type="button"
                className={scss.quickAction}
                onClick={() => toggleStatus("attention")}
              >
                <IconAlertTriangle size={15} />
                <span>Needs attention</span>
                <IconChevronRight size={14} />
              </button>
              <Link href="/inventory/batches" className={scss.quickAction}>
                <IconPackage size={15} />
                <span>View inventory batches</span>
                <IconChevronRight size={14} />
              </Link>
              <Link href="/purchasing" className={scss.quickAction}>
                <IconClipboardList size={15} />
                <span>View purchasing</span>
                <IconChevronRight size={14} />
              </Link>
            </div>
          </div>
        </aside>
        </div>
      )}

      <CreateStocktakeModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          void stocktakes.reload();
        }}
      />

      <StocktakeSummaryDrawer
        open={summaryOpen}
        stocktake={selected}
        onClose={() => {
          setSummaryOpen(false);
          setSelected(null);
        }}
      />
    </div>
  );
}
