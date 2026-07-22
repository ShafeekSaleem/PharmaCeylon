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
  IconFileText,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTruck,
  IconX,
} from "@/components/icons";
import { ProductContextBanner } from "@/components/product-context-banner";
import { ActionButton, DataTable, PageHeader, StatCard, StatusBadge, type Column } from "@/components/ui";
import { fetchTenantBranches, type TenantBranch } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";
import { InventoryFilterSelect } from "../inventory/components/inventory-filter-select";
import inventoryCss from "../inventory/inventory.module.css";
import layoutCss from "../purchasing/purchasing.module.css";
import { CreateReturnModal } from "./components/create-return-modal";
import { ReturnDetailModal } from "./components/return-detail-modal";
import { STATUS_OPTIONS, SUMMARY_PERIOD_OPTIONS, TYPE_OPTIONS } from "./constants";
import { useReturns } from "./hooks/use-returns";
import rcss from "./returns.module.css";
import {
  PAGE_SIZE,
  type GoodsReturnStatusFilter,
  type GoodsReturnTypeFilter,
  type ReturnListItem,
  type SummaryPeriod,
} from "./types";
import {
  displayStatus,
  displayStatusLabel,
  formatDate,
  formatMoney,
  formatReturnNo,
  hasReturnWriteAccess,
  parseDateOnlyLocal,
  periodSummaryFromReturns,
  resolveSummaryPeriod,
  returnLineCount,
  returnPartyLabel,
  startOfMonthIso,
  todayIsoDate,
} from "./utils";

function ReturnsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, branchId } = useAuth();
  const canWrite = hasReturnWriteAccess(user, branchId);
  const returns = useReturns();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<GoodsReturnStatusFilter>("all");
  const [typeFilter, setTypeFilter] = useState<GoodsReturnTypeFilter>("all");
  const [branchFilter, setBranchFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const [summaryPeriod, setSummaryPeriod] = useState<SummaryPeriod>("this_month");
  const [createOpen, setCreateOpen] = useState(false);
  const [detailReturn, setDetailReturn] = useState<ReturnListItem | null>(null);
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
  }, [search, statusFilter, typeFilter, branchFilter, dateFrom, dateTo, productId]);

  const branchOptions = useMemo(
    () => [
      { value: "all", label: "All branches" },
      ...branches.map((b) => ({ value: b.id, label: b.name })),
    ],
    [branches],
  );

  const summary = useMemo(() => {
    const counts = {
      draft: 0,
      pending_approval: 0,
      awaiting_logistics: 0,
      in_review: 0,
      completed: 0,
      rejected: 0,
    };
    for (const row of returns.rows) {
      if (row.status in counts) {
        counts[row.status as keyof typeof counts] += 1;
      }
    }
    return counts;
  }, [returns.rows]);

  const periodStats = useMemo(
    () => periodSummaryFromReturns(returns.rows, summaryPeriod),
    [returns.rows, summaryPeriod],
  );

  const summaryPeriodLabel = useMemo(
    () => resolveSummaryPeriod(summaryPeriod).label,
    [summaryPeriod],
  );

  const alerts = useMemo(() => {
    const pendingApproval = returns.rows.filter((r) => r.status === "pending_approval").length;
    const awaiting = returns.rows.filter((r) => r.status === "awaiting_logistics").length;
    const inReview = returns.rows.filter((r) => r.status === "in_review").length;
    const drafts = returns.rows.filter((r) => r.status === "draft").length;
    return [
      {
        key: "approval",
        label: "Pending approval",
        hint: "Needs manager sign-off",
        count: pendingApproval,
        tone: "warning" as const,
        filter: "pending_approval" as GoodsReturnStatusFilter,
      },
      {
        key: "logistics",
        label: "Awaiting pickup/dispatch",
        hint: "Logistics step pending",
        count: awaiting,
        tone: "info" as const,
        filter: "awaiting_logistics" as GoodsReturnStatusFilter,
      },
      {
        key: "review",
        label: "In review",
        hint: "Ready to complete",
        count: inReview,
        tone: "info" as const,
        filter: "in_review" as GoodsReturnStatusFilter,
      },
      {
        key: "draft",
        label: "Draft returns",
        hint: "Not yet submitted",
        count: drafts,
        tone: "info" as const,
        filter: "draft" as GoodsReturnStatusFilter,
      },
    ].filter((a) => a.count > 0);
  }, [returns.rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return returns.rows.filter((row) => {
      if (productId && !row.items.some((i) => i.product.id === productId)) return false;
      if (statusFilter !== "all" && row.status !== statusFilter) return false;
      if (typeFilter !== "all" && row.type !== typeFilter) return false;
      if (branchFilter !== "all" && row.branchId !== branchFilter) return false;
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
        formatReturnNo(row),
        row.type,
        returnPartyLabel(row),
        row.reason ?? "",
        row.notes ?? "",
        row.requester.fullName,
        row.supplier?.name ?? "",
        row.customerName ?? "",
        row.sale?.invoiceNo ?? "",
        ...row.items.map((i) => `${i.product.sku} ${i.product.name}`),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [
    returns.rows,
    search,
    statusFilter,
    typeFilter,
    branchFilter,
    dateFrom,
    dateTo,
    productId,
  ]);

  const paged = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }, [filtered, page]);

  const isThisMonthPreset = dateFrom === startOfMonthIso() && dateTo === todayIsoDate();

  function toggleStatus(next: GoodsReturnStatusFilter) {
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
    setTypeFilter("all");
    setBranchFilter("all");
    setDateFrom("");
    setDateTo("");
    setPage(1);
    if (productId) {
      const next = new URLSearchParams(searchParams.toString());
      next.delete("productId");
      const qs = next.toString();
      router.replace(qs ? `/returns?${qs}` : "/returns");
    }
  }

  const filtersActive =
    search.trim().length > 0 ||
    statusFilter !== "all" ||
    typeFilter !== "all" ||
    branchFilter !== "all" ||
    !!dateFrom ||
    !!dateTo ||
    !!productId;

  function exportCsv() {
    const header = [
      "Return No",
      "Type",
      "Party",
      "Reason",
      "Status",
      "Items",
      "Qty",
      "Amount",
      "Requested",
      "Updated",
      "Requested by",
    ];
    const lines = filtered.map((row) => [
      formatReturnNo(row),
      row.type,
      returnPartyLabel(row),
      row.reason ?? "",
      row.status,
      String(row.items.length),
      String(returnLineCount(row.items)),
      String(row.amount),
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
    a.download = "returns-export.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  const columns: Column<ReturnListItem>[] = useMemo(
    () => [
      {
        key: "returnNo",
        header: "Return no.",
        render: (row) => (
          <button
            type="button"
            className={rcss.returnNo}
            onClick={() => setDetailReturn(row)}
          >
            {formatReturnNo(row)}
          </button>
        ),
      },
      {
        key: "type",
        header: "Type",
        render: (row) => (
          <span
            className={`${rcss.typeTag} ${
              row.type === "customer" ? rcss.typeTagCustomer : rcss.typeTagSupplier
            }`}
          >
            {row.type === "customer" ? "Customer" : "Supplier"}
          </span>
        ),
      },
      {
        key: "party",
        header: "From / customer / supplier",
        render: (row) => (
          <div className={rcss.partyCell}>
            <span className={rcss.partyName}>{returnPartyLabel(row)}</span>
            {row.type === "customer" && row.sale?.invoiceNo ? (
              <span className={rcss.partyMeta}>{row.sale.invoiceNo}</span>
            ) : null}
            {row.type === "supplier" && row.supplier?.code ? (
              <span className={rcss.partyMeta}>{row.supplier.code}</span>
            ) : null}
          </div>
        ),
      },
      {
        key: "reason",
        header: "Reason",
        render: (row) => (
          <span className={layoutCss.muted}>{row.reason?.trim() || "—"}</span>
        ),
      },
      {
        key: "status",
        header: "Status",
        render: (row) => (
          <StatusBadge
            status={displayStatus(row)}
            label={displayStatusLabel(row.status, row.type)}
          />
        ),
      },
      {
        key: "items",
        header: "Items / qty",
        render: (row) => (
          <span className={layoutCss.muted}>
            {row.items.length} item{row.items.length === 1 ? "" : "s"} ·{" "}
            {returnLineCount(row.items)} units
          </span>
        ),
      },
      {
        key: "amount",
        header: "Amount",
        render: (row) => <span>{formatMoney(row.amount)}</span>,
      },
      {
        key: "requested",
        header: "Requested",
        render: (row) => (
          <div className={rcss.dateStack}>
            <span>{formatDate(row.createdAt)}</span>
            <span className={layoutCss.muted}>{row.requester.fullName}</span>
          </div>
        ),
      },
      {
        key: "updated",
        header: "Processed / updated",
        render: (row) => (
          <div className={rcss.dateStack}>
            <span>{formatDate(row.updatedAt)}</span>
            <span className={layoutCss.muted}>
              {row.processor?.fullName ?? row.approver?.fullName ?? "—"}
            </span>
          </div>
        ),
      },
      {
        key: "actions",
        header: "Actions",
        width: "64px",
        align: "right",
        render: (row) => (
          <div className={layoutCss.actionsCell}>
            <button
              type="button"
              className={`${layoutCss.actionIcon} ${layoutCss.actionIconView}`}
              onClick={() => setDetailReturn(row)}
              aria-label={`View ${formatReturnNo(row)}`}
              data-tooltip="View return"
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
        description="Create customer and supplier returns, approve them, handle pickup/dispatch, and complete stock adjustments."
        actions={
          canWrite ? (
            <ActionButton
              icon={<IconPlus size={16} />}
              tooltip="Create a customer or supplier return"
              onClick={() => setCreateOpen(true)}
            >
              New return
            </ActionButton>
          ) : null
        }
      />

      {!returns.hasBranch && (
        <div className={layoutCss.branchNotice}>
          Select a branch in the header to view returns for that location.
        </div>
      )}

      {returns.hasBranch && (
        <div className={layoutCss.dashboard}>
          <div className={layoutCss.mainCol}>
            <div className={layoutCss.kpiRow}>
              <StatCard
                title="Draft"
                value={summary.draft}
                subtitle="Not submitted"
                icon={<IconFileText size={16} />}
                iconTone="info"
                active={statusFilter === "draft"}
                onClick={() => toggleStatus("draft")}
              />
              <StatCard
                title="Pending approval"
                value={summary.pending_approval}
                subtitle="Awaiting approval"
                icon={<IconBell size={16} />}
                iconTone="warning"
                active={statusFilter === "pending_approval"}
                onClick={() => toggleStatus("pending_approval")}
              />
              <StatCard
                title="Awaiting pickup/dispatch"
                value={summary.awaiting_logistics}
                subtitle="Logistics pending"
                icon={<IconTruck size={16} />}
                iconTone="info"
                active={statusFilter === "awaiting_logistics"}
                onClick={() => toggleStatus("awaiting_logistics")}
              />
              <StatCard
                title="In review"
                value={summary.in_review}
                subtitle="Ready to complete"
                icon={<IconClipboardList size={16} />}
                iconTone="primary"
                active={statusFilter === "in_review"}
                onClick={() => toggleStatus("in_review")}
              />
              <StatCard
                title="Completed"
                value={summary.completed}
                subtitle="Stock posted"
                icon={<IconCheck size={16} />}
                iconTone="success"
                active={statusFilter === "completed"}
                onClick={() => toggleStatus("completed")}
              />
              <StatCard
                title="Rejected"
                value={summary.rejected}
                subtitle="Declined"
                icon={<IconX size={16} />}
                iconTone="danger"
                active={statusFilter === "rejected"}
                onClick={() => toggleStatus("rejected")}
              />
            </div>

            <div className={layoutCss.toolbar}>
              <div className={layoutCss.searchWrap}>
                <IconSearch size={15} className={layoutCss.searchIcon} />
                <input
                  type="search"
                  className={layoutCss.searchInput}
                  placeholder="Search return no., party, items…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <InventoryFilterSelect
                label="Return type"
                value={typeFilter}
                options={[...TYPE_OPTIONS]}
                onChange={(v) => setTypeFilter(v as GoodsReturnTypeFilter)}
              />
              <InventoryFilterSelect
                label="Status"
                value={statusFilter}
                options={[...STATUS_OPTIONS]}
                onChange={(v) => setStatusFilter(v as GoodsReturnStatusFilter)}
              />
              <InventoryFilterSelect
                label="Branch"
                value={branchFilter}
                options={branchOptions}
                onChange={setBranchFilter}
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
              <button
                type="button"
                className={layoutCss.actionBtn}
                onClick={exportCsv}
                data-tooltip="Download filtered returns as CSV"
              >
                <IconDownload size={14} />
                Export
              </button>
            </div>

            {returns.error && <Alert variant="error">{returns.error}</Alert>}

            {filtersActive && (
              <div className={layoutCss.activeFilter}>
                <span>
                  Filtered returns · {filtered.length} return
                  {filtered.length === 1 ? "" : "s"}
                </span>
                <button
                  type="button"
                  className={layoutCss.clearFilter}
                  onClick={clearFilters}
                  data-tooltip="Reset all return filters"
                >
                  Clear filter
                </button>
              </div>
            )}

            <DataTable
              columns={columns}
              data={paged}
              rowKey={(r) => r.id}
              loading={returns.loading}
              page={page}
              pageSize={PAGE_SIZE}
              total={filtered.length}
              onPageChange={setPage}
              emptyTitle="No returns match your filters"
              emptyDescription={
                canWrite
                  ? "Create a return for a customer refund or supplier credit"
                  : "Returns for this branch will appear here"
              }
              emptyIcon={<IconRefresh size={48} />}
              compact
            />
          </div>

          <aside className={layoutCss.sideCol}>
            <div className={layoutCss.sideCard}>
              <div className={inventoryCss.summaryHeader}>
                <h3 className={`${layoutCss.sideCardTitle} ${layoutCss.sideCardTitleFlush}`}>
                  Returns summary
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
                  <span>Total value</span>
                  <span className={layoutCss.summaryValue}>
                    {formatMoney(periodStats.totalValue)}
                  </span>
                </div>
                <div className={layoutCss.summaryRow}>
                  <span>Refunded (customer)</span>
                  <span className={layoutCss.summaryValue}>
                    {formatMoney(periodStats.refundedCustomer)}
                  </span>
                </div>
                <div className={layoutCss.summaryRow}>
                  <span>Supplier credits</span>
                  <span className={layoutCss.summaryValue}>
                    {formatMoney(periodStats.supplierCredits)}
                  </span>
                </div>
                <div className={`${layoutCss.summaryRow} ${layoutCss.summaryHighlight}`}>
                  <span>Net</span>
                  <span className={layoutCss.summaryValue}>
                    {formatMoney(periodStats.net)}
                  </span>
                </div>
              </div>
              <p className={layoutCss.fieldHint}>
                {periodStats.returnCount} return
                {periodStats.returnCount === 1 ? "" : "s"} in period
              </p>
              <Link href="/inventory/movements?category=returns" className={layoutCss.sideLink}>
                View return movements →
              </Link>
            </div>

            <div className={layoutCss.sideCard}>
              <h3 className={layoutCss.sideCardTitle}>Return alerts</h3>
              {alerts.length === 0 ? (
                <p className={layoutCss.fieldHint}>No return alerts right now.</p>
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
              <div className={rcss.quickActions}>
                {canWrite && (
                  <button
                    type="button"
                    className={rcss.quickAction}
                    onClick={() => setCreateOpen(true)}
                  >
                    <IconPlus size={15} />
                    <span>Create return</span>
                    <IconChevronRight size={14} />
                  </button>
                )}
                <button
                  type="button"
                  className={rcss.quickAction}
                  onClick={() => toggleStatus("pending_approval")}
                >
                  <IconBell size={15} />
                  <span>Pending approvals</span>
                  <IconChevronRight size={14} />
                </button>
                <button
                  type="button"
                  className={rcss.quickAction}
                  onClick={() => toggleStatus("awaiting_logistics")}
                >
                  <IconRefresh size={15} />
                  <span>Awaiting logistics</span>
                  <IconChevronRight size={14} />
                </button>
                <Link href="/inventory" className={rcss.quickAction}>
                  <IconClipboardList size={15} />
                  <span>View inventory</span>
                  <IconChevronRight size={14} />
                </Link>
              </div>
            </div>
          </aside>
        </div>
      )}

      <CreateReturnModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => void returns.reload()}
      />

      <ReturnDetailModal
        returnItem={detailReturn}
        branchId={branchId}
        user={user}
        onClose={() => setDetailReturn(null)}
        onChanged={() => void returns.reload()}
      />
    </div>
  );
}

export default function ReturnsPage() {
  return (
    <Suspense fallback={null}>
      <ReturnsContent />
    </Suspense>
  );
}
