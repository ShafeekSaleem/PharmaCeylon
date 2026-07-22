"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Alert } from "@/components/alert";
import {
  IconAlertTriangle,
  IconBell,
  IconCalendar,
  IconCheck,
  IconChevronRight,
  IconClipboardList,
  IconDownload,
  IconEye,
  IconPackage,
  IconPlus,
  IconSearch,
  IconTruck,
} from "@/components/icons";
import { ProductContextBanner } from "@/components/product-context-banner";
import { ActionButton, DataTable, PageHeader, StatCard, StatusBadge, type Column } from "@/components/ui";
import { fetchTenantBranches, type TenantBranch } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";
import { InventoryFilterSelect } from "../inventory/components/inventory-filter-select";
import inventoryCss from "../inventory/inventory.module.css";
import layoutCss from "../purchasing/purchasing.module.css";
import { CreateTransferModal } from "./components/create-transfer-modal";
import { TransferDetailModal } from "./components/transfer-detail-modal";
import { STATUS_OPTIONS, SUMMARY_PERIOD_OPTIONS } from "./constants";
import { useTransfers } from "./hooks/use-transfers";
import tcss from "./transfers.module.css";
import { PAGE_SIZE, type SummaryPeriod, type TransferListItem, type TransferStatusFilter } from "./types";
import {
  displayTransferStatus,
  formatDate,
  formatTransferNo,
  hasTransferWriteAccess,
  isTransferOverdue,
  matchesStatusFilter,
  parseDateOnlyLocal,
  periodSummaryFromTransfers,
  receivedPercent,
  receivedProgressTone,
  resolveSummaryPeriod,
  startOfMonthIso,
  todayIsoDate,
  transferLineCount,
} from "./utils";

function TransfersContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, branchId } = useAuth();
  const canWrite = hasTransferWriteAccess(user, branchId);
  const transfers = useTransfers();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<TransferStatusFilter>("all");
  const [fromBranchFilter, setFromBranchFilter] = useState("all");
  const [toBranchFilter, setToBranchFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const [summaryPeriod, setSummaryPeriod] = useState<SummaryPeriod>("this_month");
  const [createOpen, setCreateOpen] = useState(false);
  const [detailTransfer, setDetailTransfer] = useState<TransferListItem | null>(null);
  const [branches, setBranches] = useState<TenantBranch[]>([]);

  const productId = searchParams.get("productId");

  useEffect(() => {
    let cancelled = false;
    fetchTenantBranches()
      .then((rows) => {
        if (!cancelled) setBranches(rows);
      })
      .catch(() => {
        if (!cancelled) setBranches([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setPage(1);
  }, [search, statusFilter, fromBranchFilter, toBranchFilter, dateFrom, dateTo, productId]);

  const branchOptions = useMemo(
    () => [
      { value: "all", label: "All branches" },
      ...branches.map((b) => ({ value: b.id, label: b.name })),
    ],
    [branches],
  );

  const summary = useMemo(() => {
    const counts = {
      requested: 0,
      approved: 0,
      in_transit: 0,
      partially_received: 0,
      received: 0,
      overdue: 0,
    };
    for (const row of transfers.rows) {
      if (row.status === "requested") counts.requested += 1;
      if (row.status === "approved") counts.approved += 1;
      if (row.status === "in_transit") counts.in_transit += 1;
      if (row.status === "partially_received") counts.partially_received += 1;
      if (row.status === "received") counts.received += 1;
      if (isTransferOverdue(row)) counts.overdue += 1;
    }
    return counts;
  }, [transfers.rows]);

  const periodStats = useMemo(
    () => periodSummaryFromTransfers(transfers.rows, summaryPeriod),
    [transfers.rows, summaryPeriod],
  );

  const summaryPeriodLabel = useMemo(
    () => resolveSummaryPeriod(summaryPeriod).label,
    [summaryPeriod],
  );

  const alerts = useMemo(() => {
    const overdue = transfers.rows.filter(isTransferOverdue).length;
    const pendingReceipt = transfers.rows.filter(
      (r) => r.status === "in_transit" || r.status === "partially_received",
    ).length;
    const pendingApproval = transfers.rows.filter((r) => r.status === "requested").length;
    return [
      {
        key: "overdue",
        label: "Delayed transfers",
        hint: "Past expected delivery date",
        count: overdue,
        tone: "danger" as const,
        filter: "overdue" as TransferStatusFilter,
      },
      {
        key: "receipt",
        label: "Pending receipts",
        hint: "Awaiting confirmation",
        count: pendingReceipt,
        tone: "warning" as const,
        filter: "in_transit" as TransferStatusFilter,
      },
      {
        key: "approval",
        label: "Pending approval",
        hint: "Needs manager sign-off",
        count: pendingApproval,
        tone: "info" as const,
        filter: "requested" as TransferStatusFilter,
      },
    ].filter((a) => a.count > 0);
  }, [transfers.rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return transfers.rows.filter((row) => {
      if (productId && !row.items.some((i) => i.productId === productId)) return false;
      if (!matchesStatusFilter(row, statusFilter)) return false;
      if (fromBranchFilter !== "all" && row.fromBranchId !== fromBranchFilter) return false;
      if (toBranchFilter !== "all" && row.toBranchId !== toBranchFilter) return false;
      if (dateFrom) {
        const from = parseDateOnlyLocal(dateFrom);
        const created = new Date(row.createdAt);
        if (from && created < from) return false;
      }
      if (dateTo) {
        const to = parseDateOnlyLocal(dateTo);
        if (to) {
          to.setHours(23, 59, 59, 999);
          const created = new Date(row.createdAt);
          if (created > to) return false;
        }
      }
      if (!q) return true;
      const hay = [
        formatTransferNo(row.id),
        row.fromBranch.name,
        row.toBranch.name,
        row.requester.fullName,
        row.notes ?? "",
        ...row.items.map((i) => `${i.product.sku} ${i.product.name}`),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [
    transfers.rows,
    search,
    statusFilter,
    fromBranchFilter,
    toBranchFilter,
    dateFrom,
    dateTo,
    productId,
  ]);

  const paged = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }, [filtered, page]);

  const isThisMonthPreset = dateFrom === startOfMonthIso() && dateTo === todayIsoDate();

  function toggleStatus(next: TransferStatusFilter) {
    setStatusFilter((cur) => (cur === next ? "all" : next));
  }

  function toggleThisMonth() {
    if (isThisMonthPreset) {
      setDateFrom("");
      setDateTo("");
    } else {
      setDateFrom(startOfMonthIso());
      setDateTo(todayIsoDate());
    }
  }

  function clearFilters() {
    setSearch("");
    setStatusFilter("all");
    setFromBranchFilter("all");
    setToBranchFilter("all");
    setDateFrom("");
    setDateTo("");
    setPage(1);
    if (productId) {
      const next = new URLSearchParams(searchParams.toString());
      next.delete("productId");
      const qs = next.toString();
      router.replace(qs ? `/transfers?${qs}` : "/transfers");
    }
  }

  const filtersActive =
    search.trim().length > 0 ||
    statusFilter !== "all" ||
    fromBranchFilter !== "all" ||
    toBranchFilter !== "all" ||
    !!dateFrom ||
    !!dateTo ||
    !!productId;

  function exportCsv() {
    const header = [
      "Transfer",
      "From",
      "To",
      "Status",
      "Items",
      "Units",
      "Requested",
      "Updated",
      "Created by",
    ];
    const lines = filtered.map((row) => [
      formatTransferNo(row.id),
      row.fromBranch.name,
      row.toBranch.name,
      displayTransferStatus(row),
      String(row.items.length),
      String(transferLineCount(row.items)),
      row.createdAt,
      row.updatedAt,
      row.requester.fullName,
    ]);
    const csv = [header, ...lines]
      .map((cols) => cols.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "transfers-export.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  const columns: Column<TransferListItem>[] = useMemo(
    () => [
      {
        key: "transferNo",
        header: "Transfer no.",
        render: (row) => (
          <button
            type="button"
            className={tcss.transferNo}
            onClick={() => setDetailTransfer(row)}
          >
            {formatTransferNo(row.id)}
          </button>
        ),
      },
      {
        key: "branches",
        header: "From / to branch",
        render: (row) => (
          <div className={tcss.branchPair}>
            <span className={tcss.branchFrom}>{row.fromBranch.name}</span>
            <span className={tcss.branchArrow}>↓</span>
            <span className={tcss.branchTo}>{row.toBranch.name}</span>
          </div>
        ),
      },
      {
        key: "status",
        header: "Status",
        render: (row) => {
          const status = displayTransferStatus(row);
          return (
            <div className={tcss.statusCell}>
              <StatusBadge status={status} />
            </div>
          );
        },
      },
      {
        key: "items",
        header: "Items / qty",
        render: (row) => (
          <span>
            {row.items.length} item{row.items.length === 1 ? "" : "s"} ·{" "}
            {transferLineCount(row.items)} units
          </span>
        ),
      },
      {
        key: "dates",
        header: "Requested / expected",
        render: (row) => (
          <div className={tcss.dateStack}>
            <span>
              <span className={tcss.dateStackLabel}>Req </span>
              {formatDate(row.createdAt)}
            </span>
            <span className={layoutCss.muted}>
              <span className={tcss.dateStackLabel}>Exp </span>
              {formatDate(row.expectedOn)}
            </span>
          </div>
        ),
      },
      {
        key: "progress",
        header: "Received progress",
        render: (row) => {
          const pct = receivedPercent(row);
          const overdue = isTransferOverdue(row);
          const toneKey = receivedProgressTone(row, overdue);
          const tone =
            toneKey === "danger"
              ? tcss.progressFillDanger
              : toneKey === "done"
                ? layoutCss.progressFillDone
                : toneKey === "warn"
                  ? layoutCss.progressFillWarn
                  : "";
          const hint =
            pct === 0 && (row.dispatchedQty ?? 0) > 0 ? " · Dispatched" : "";
          return (
            <div className={tcss.receivedCell}>
              <span className={tcss.receivedMeta}>
                {pct}%{hint}
              </span>
              <div className={layoutCss.progressTrack} aria-hidden>
                <div
                  className={`${layoutCss.progressFill}${tone ? ` ${tone}` : ""}`}
                  style={{ width: `${Math.max(pct, toneKey === "warn" && pct === 0 ? 8 : 0)}%` }}
                />
              </div>
            </div>
          );
        },
      },
      {
        key: "createdBy",
        header: "Created by",
        render: (row) => <span className={layoutCss.muted}>{row.requester.fullName}</span>,
      },
      {
        key: "actions",
        header: "Actions",
        render: (row) => (
          <div className={layoutCss.actionsCell}>
            <button
              type="button"
              className={`${layoutCss.actionIcon} ${layoutCss.actionIconView}`}
              onClick={() => setDetailTransfer(row)}
              aria-label={`View ${formatTransferNo(row.id)}`}
              data-tooltip="View transfer"
            >
              <IconEye size={17} />
            </button>
          </div>
        ),
      },
    ],
    [],
  );

  return (
    <div className={layoutCss.page}>
      <ProductContextBanner />

      <PageHeader
        subtitleOnly
        floatingActions
        description="Create stock transfers between branches, dispatch them, receive them, and track movement status."
        actions={
          canWrite ? (
            <ActionButton icon={<IconPlus size={16} />} onClick={() => setCreateOpen(true)}>
              New transfer
            </ActionButton>
          ) : null
        }
      />

      {!transfers.hasBranch && (
        <div className={layoutCss.branchNotice}>
          Select a branch in the header to view transfers involving that location.
        </div>
      )}

      {transfers.hasBranch && (
        <div className={layoutCss.dashboard}>
          <div className={layoutCss.mainCol}>
            <div className={layoutCss.kpiRow}>
              <StatCard
                title="Pending approval"
                value={summary.requested}
                subtitle="Awaiting approval"
                icon={<IconBell size={16} />}
                iconTone="warning"
                active={statusFilter === "requested"}
                onClick={() => toggleStatus("requested")}
              />
              <StatCard
                title="Ready to ship"
                value={summary.approved}
                subtitle="Approved, not dispatched"
                icon={<IconClipboardList size={16} />}
                iconTone="info"
                active={statusFilter === "approved"}
                onClick={() => toggleStatus("approved")}
              />
              <StatCard
                title="In transit"
                value={summary.in_transit}
                subtitle="On the way"
                icon={<IconTruck size={16} />}
                iconTone="primary"
                active={statusFilter === "in_transit"}
                onClick={() => toggleStatus("in_transit")}
              />
              <StatCard
                title="Partially received"
                value={summary.partially_received}
                subtitle="In progress"
                icon={<IconPackage size={16} />}
                iconTone="warning"
                active={statusFilter === "partially_received"}
                onClick={() => toggleStatus("partially_received")}
              />
              <StatCard
                title="Completed"
                value={summary.received}
                subtitle="Fully received"
                icon={<IconCheck size={16} />}
                iconTone="success"
                active={statusFilter === "received"}
                onClick={() => toggleStatus("received")}
              />
              <StatCard
                title="Overdue"
                value={summary.overdue}
                subtitle="Past expected date"
                icon={<IconCalendar size={16} />}
                iconTone="danger"
                active={statusFilter === "overdue"}
                onClick={() => toggleStatus("overdue")}
              />
            </div>

            <div className={layoutCss.toolbar}>
              <div className={layoutCss.searchWrap}>
                <IconSearch size={15} className={layoutCss.searchIcon} />
                <input
                  type="search"
                  className={layoutCss.searchInput}
                  placeholder="Search transfer no., branches, items…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <InventoryFilterSelect
                label="Status"
                value={statusFilter}
                options={STATUS_OPTIONS}
                onChange={(v) => setStatusFilter(v as TransferStatusFilter)}
              />
              <InventoryFilterSelect
                label="From branch"
                value={fromBranchFilter}
                options={branchOptions}
                onChange={setFromBranchFilter}
              />
              <InventoryFilterSelect
                label="To branch"
                value={toBranchFilter}
                options={branchOptions}
                onChange={setToBranchFilter}
              />
              <div
                className={`${layoutCss.dateRange}${dateFrom || dateTo ? ` ${layoutCss.dateRangeFilled}` : ""}`}
                role="group"
                aria-label="Created date range"
              >
                <span className={layoutCss.dateRangeIcon} aria-hidden>
                  <IconCalendar size={14} />
                </span>
                <div className={layoutCss.dateRangeFields}>
                  <label className={layoutCss.dateRangeField}>
                    <span className={layoutCss.dateRangeLabel}>From</span>
                    <input
                      type="date"
                      value={dateFrom}
                      onChange={(e) => setDateFrom(e.target.value)}
                      aria-label="Created from"
                    />
                  </label>
                  <span className={layoutCss.dateRangeSep} aria-hidden>
                    →
                  </span>
                  <label className={layoutCss.dateRangeField}>
                    <span className={layoutCss.dateRangeLabel}>To</span>
                    <input
                      type="date"
                      value={dateTo}
                      onChange={(e) => setDateTo(e.target.value)}
                      aria-label="Created to"
                    />
                  </label>
                </div>
              </div>
              <button
                type="button"
                className={`${layoutCss.periodChip}${isThisMonthPreset ? ` ${layoutCss.periodChipActive}` : ""}`}
                onClick={toggleThisMonth}
                aria-pressed={isThisMonthPreset}
              >
                <IconCalendar size={13} />
                This month
              </button>
              <div className={layoutCss.toolbarSpacer} />
              <button type="button" className={layoutCss.actionBtn} onClick={exportCsv}>
                <IconDownload size={14} />
                Export
              </button>
            </div>

            {transfers.error && <Alert variant="error">{transfers.error}</Alert>}

            {filtersActive && (
              <div className={layoutCss.activeFilter}>
                <span>
                  Filtered transfers · {filtered.length} transfer
                  {filtered.length === 1 ? "" : "s"}
                </span>
                <button
                  type="button"
                  className={layoutCss.clearFilter}
                  onClick={clearFilters}
                  data-tooltip="Reset all transfer filters"
                >
                  Clear filter
                </button>
              </div>
            )}

            <DataTable
              columns={columns}
              data={paged}
              rowKey={(r) => r.id}
              loading={transfers.loading}
              page={page}
              pageSize={PAGE_SIZE}
              total={filtered.length}
              onPageChange={setPage}
              emptyTitle="No transfers match your filters"
              emptyDescription={
                canWrite
                  ? "Create a transfer to move stock between branches"
                  : "Transfers involving this branch will appear here"
              }
              emptyIcon={<IconTruck size={48} />}
              compact
            />
          </div>

          <aside className={layoutCss.sideCol}>
            <div className={layoutCss.sideCard}>
              <div className={inventoryCss.summaryHeader}>
                <h3 className={`${layoutCss.sideCardTitle} ${layoutCss.sideCardTitleFlush}`}>
                  Transfer summary
                </h3>
                <InventoryFilterSelect
                  label="Period"
                  value={summaryPeriod}
                  options={SUMMARY_PERIOD_OPTIONS}
                  onChange={(value) => setSummaryPeriod(value as SummaryPeriod)}
                />
              </div>
              <p className={layoutCss.periodLabel}>{summaryPeriodLabel}</p>
              <div className={layoutCss.summaryGrid}>
                <div className={layoutCss.summaryRow}>
                  <span>Total sent (qty)</span>
                  <span className={layoutCss.summaryValue}>{periodStats.totalSent}</span>
                </div>
                <div className={layoutCss.summaryRow}>
                  <span>Total received (qty)</span>
                  <span className={layoutCss.summaryValue}>{periodStats.totalReceived}</span>
                </div>
                <div className={layoutCss.summaryRow}>
                  <span>In transit (qty)</span>
                  <span className={layoutCss.summaryValue}>{periodStats.inTransit}</span>
                </div>
                <div className={`${layoutCss.summaryRow} ${layoutCss.summaryHighlight}`}>
                  <span>Net movement</span>
                  <span className={layoutCss.summaryValue}>+{periodStats.net}</span>
                </div>
              </div>
              <p className={layoutCss.fieldHint}>
                {periodStats.transferCount} transfer
                {periodStats.transferCount === 1 ? "" : "s"} in period
              </p>
              <Link href="/inventory/movements?category=transfers" className={layoutCss.sideLink}>
                View transfer movements →
              </Link>
            </div>

            <div className={layoutCss.sideCard}>
              <h3 className={layoutCss.sideCardTitle}>Transfer alerts</h3>
              {alerts.length === 0 ? (
                <p className={layoutCss.fieldHint}>No transfer alerts right now.</p>
              ) : (
                <ul className={layoutCss.alertList}>
                  {alerts.map((alert) => (
                    <li key={alert.key}>
                      <button
                        type="button"
                        className={layoutCss.alertItem}
                        onClick={() => toggleStatus(alert.filter)}
                      >
                        <div className={layoutCss.alertItemLeft}>
                          <span
                            className={`${layoutCss.alertIcon} ${
                              alert.tone === "danger"
                                ? layoutCss.alertIconDanger
                                : alert.tone === "warning"
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
              <div className={tcss.quickActions}>
                {canWrite && (
                  <button
                    type="button"
                    className={tcss.quickAction}
                    onClick={() => setCreateOpen(true)}
                  >
                    <IconPlus size={15} />
                    <span>Create transfer</span>
                    <IconChevronRight size={14} />
                  </button>
                )}
                <button
                  type="button"
                  className={tcss.quickAction}
                  onClick={() => toggleStatus("in_transit")}
                >
                  <IconPackage size={15} />
                  <span>Receive transfer</span>
                  <IconChevronRight size={14} />
                </button>
                <button
                  type="button"
                  className={tcss.quickAction}
                  onClick={() => toggleStatus("requested")}
                >
                  <IconBell size={15} />
                  <span>Pending approvals</span>
                  <IconChevronRight size={14} />
                </button>
                <Link href="/inventory" className={tcss.quickAction}>
                  <IconTruck size={15} />
                  <span>View branches stock</span>
                  <IconChevronRight size={14} />
                </Link>
              </div>
            </div>
          </aside>
        </div>
      )}

      <CreateTransferModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => void transfers.reload()}
      />

      <TransferDetailModal
        transfer={detailTransfer}
        branchId={branchId}
        canWrite={canWrite}
        user={user}
        onClose={() => setDetailTransfer(null)}
        onChanged={() => void transfers.reload()}
      />
    </div>
  );
}

export default function TransfersPage() {
  return (
    <Suspense fallback={null}>
      <TransfersContent />
    </Suspense>
  );
}
