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
  IconClipboardList,
  IconDownload,
  IconEdit,
  IconEye,
  IconActivity,
  IconBox,
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
import { CreatePoModal } from "./components/create-po-modal";
import { PoDetailModal } from "./components/po-detail-modal";
import { SUMMARY_PERIOD_OPTIONS } from "./constants";
import { usePurchaseOrders } from "./hooks/use-purchase-orders";
import css from "./purchasing.module.css";
import { PAGE_SIZE, type PoStatusFilter, type PurchaseOrderListItem, type SummaryPeriod } from "./types";
import {
  canApprovePurchaseOrder,
  canCancelPurchaseOrder,
  canEditPo,
  canAdjustExpected,
  displayPoStatus,
  formatDate,
  formatMoney,
  hasPurchasingWriteAccess,
  isDateInSummaryPeriod,
  isPoOverdue,
  parseDateOnlyLocal,
  poEstimatedValue,
  poLineCount,
  receivedPercent,
  resolveSummaryPeriod,
  startOfMonthIso,
  todayIsoDate,
} from "./utils";

const STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "draft", label: "Draft" },
  { value: "pending_approval", label: "Pending approval" },
  { value: "issued", label: "Issued" },
  { value: "partially_received", label: "Partially received" },
  { value: "receivable", label: "Ready to receive" },
  { value: "received", label: "Received" },
  { value: "short_closed", label: "Short closed" },
  { value: "overdue", label: "Overdue" },
  { value: "cancelled", label: "Cancelled" },
] as const;

function PurchasingContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, branchId, setBranchId } = useAuth();
  const canWrite = hasPurchasingWriteAccess(user, branchId);
  const canCancel = canCancelPurchaseOrder(user, branchId);
  const canApprove = canApprovePurchaseOrder(user, branchId);
  const orders = usePurchaseOrders();

  const productId = searchParams.get("productId");
  const action = searchParams.get("action");
  const poParam = searchParams.get("po");

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<PoStatusFilter>("all");
  const [supplierFilter, setSupplierFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const [summaryPeriod, setSummaryPeriod] = useState<SummaryPeriod>("this_month");
  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailStartInEdit, setDetailStartInEdit] = useState(false);
  const [branches, setBranches] = useState<TenantBranch[]>([]);

  useEffect(() => {
    if (action === "create-po" && canWrite) setCreateOpen(true);
  }, [action, canWrite]);

  useEffect(() => {
    const status = searchParams.get("status");
    if (!status) return;
    const allowed: PoStatusFilter[] = [
      "all",
      "overdue",
      "receivable",
      "draft",
      "pending_approval",
      "issued",
      "partially_received",
      "received",
      "cancelled",
      "short_closed",
    ];
    if (allowed.includes(status as PoStatusFilter)) {
      setStatusFilter(status as PoStatusFilter);
    }
  }, [searchParams]);

  useEffect(() => {
    if (poParam) {
      setDetailStartInEdit(false);
      setDetailId(poParam);
    }
  }, [poParam]);

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
  }, [search, statusFilter, supplierFilter, dateFrom, dateTo, productId]);

  const branchOptions = useMemo(
    () => branches.map((b) => ({ value: b.id, label: b.name })),
    [branches],
  );

  const supplierOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of orders.rows) map.set(row.supplier.id, row.supplier.name);
    return [
      { value: "all", label: "All suppliers" },
      ...[...map.entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([value, label]) => ({ value, label })),
    ];
  }, [orders.rows]);

  const summary = useMemo(() => {
    const counts = {
      draft: 0,
      pending_approval: 0,
      issued: 0,
      partially_received: 0,
      received: 0,
      overdue: 0,
    };
    for (const row of orders.rows) {
      if (row.status === "draft") counts.draft += 1;
      if (row.status === "pending_approval") counts.pending_approval += 1;
      if (row.status === "issued") counts.issued += 1;
      if (row.status === "partially_received") counts.partially_received += 1;
      if (row.status === "received") counts.received += 1;
      if (isPoOverdue(row)) counts.overdue += 1;
    }
    return counts;
  }, [orders.rows]);

  const periodSummary = useMemo(() => {
    const periodRows = orders.rows.filter((row) =>
      isDateInSummaryPeriod(row.createdAt, summaryPeriod),
    );
    let totalOrdered = 0;
    let totalReceived = 0;
    let outstanding = 0;
    for (const row of periodRows) {
      if (row.status === "cancelled" || row.status === "short_closed") continue;
      const value = poEstimatedValue(row.items, row.shippingCharges);
      totalOrdered += value;
      const pct = receivedPercent(row) / 100;
      totalReceived += value * pct;
      if (
        row.status === "issued" ||
        row.status === "partially_received" ||
        row.status === "pending_approval" ||
        row.status === "draft"
      ) {
        outstanding += value * (1 - pct);
      }
    }
    return {
      totalOrdered,
      totalReceived,
      outstanding,
      orderCount: periodRows.length,
    };
  }, [orders.rows, summaryPeriod]);

  const summaryPeriodLabel = useMemo(
    () => resolveSummaryPeriod(summaryPeriod).label,
    [summaryPeriod],
  );

  const alerts = useMemo(() => {
    const overdue = orders.rows.filter(isPoOverdue).length;
    const pending = summary.pending_approval;
    const drafts = summary.draft;
    return [
      {
        key: "overdue",
        label: "Overdue deliveries",
        count: overdue,
        tone: "danger" as const,
        filter: "overdue" as PoStatusFilter,
      },
      {
        key: "pending",
        label: "Pending approval",
        count: pending,
        tone: "info" as const,
        filter: "pending_approval" as PoStatusFilter,
      },
      {
        key: "drafts",
        label: "Drafts awaiting issue",
        count: drafts,
        tone: "warning" as const,
        filter: "draft" as PoStatusFilter,
      },
    ].filter((a) => a.count > 0);
  }, [orders.rows, summary.draft, summary.pending_approval]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const from = parseDateOnlyLocal(dateFrom);
    const to = parseDateOnlyLocal(dateTo);
    if (to) to.setHours(23, 59, 59, 999);

    return orders.rows.filter((row) => {
      if (statusFilter === "overdue") {
        if (!isPoOverdue(row)) return false;
      } else if (statusFilter === "receivable") {
        if (row.status !== "issued" && row.status !== "partially_received") return false;
      } else if (statusFilter !== "all" && row.status !== statusFilter) {
        return false;
      }
      if (supplierFilter !== "all" && row.supplier.id !== supplierFilter) return false;
      if (productId && !row.items.some((i) => i.productId === productId)) return false;

      if (from || to) {
        const created = new Date(row.createdAt);
        if (from && created < from) return false;
        if (to && created > to) return false;
      }

      if (!q) return true;
      return (
        row.poNumber.toLowerCase().includes(q) ||
        row.supplier.name.toLowerCase().includes(q) ||
        row.supplier.code.toLowerCase().includes(q) ||
        (row.supplierReference ?? "").toLowerCase().includes(q) ||
        row.items.some(
          (i) =>
            i.product.name.toLowerCase().includes(q) ||
            i.product.sku.toLowerCase().includes(q),
        )
      );
    });
  }, [orders.rows, search, statusFilter, supplierFilter, dateFrom, dateTo, productId]);

  const paged = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }, [filtered, page]);

  function toggleStatus(next: PoStatusFilter) {
    setStatusFilter((s) => (s === next ? "all" : next));
  }

  const monthFrom = startOfMonthIso();
  const monthTo = todayIsoDate();
  const isThisMonthPreset = dateFrom === monthFrom && dateTo === monthTo;

  function toggleThisMonth() {
    if (isThisMonthPreset) {
      setDateFrom("");
      setDateTo("");
      return;
    }
    setDateFrom(monthFrom);
    setDateTo(monthTo);
  }

  function clearFilters() {
    setSearch("");
    setStatusFilter("all");
    setSupplierFilter("all");
    setDateFrom("");
    setDateTo("");
    setPage(1);
    if (productId || action === "create-po") {
      const next = new URLSearchParams(searchParams.toString());
      next.delete("productId");
      next.delete("action");
      const qs = next.toString();
      router.replace(qs ? `/purchasing?${qs}` : "/purchasing");
    }
  }

  const filtersActive =
    search.trim().length > 0 ||
    statusFilter !== "all" ||
    supplierFilter !== "all" ||
    !!dateFrom ||
    !!dateTo ||
    !!productId;

  function exportCsv() {
    const header = [
      "PO Number",
      "Supplier",
      "Status",
      "Lines",
      "Qty",
      "Est Value",
      "Expected",
      "Created",
      "Received %",
    ];
    const rows = filtered.map((row) => [
      row.poNumber,
      row.supplier.name,
      displayPoStatus(row),
      String(row.items.length),
      String(poLineCount(row.items)),
      String(poEstimatedValue(row.items, row.shippingCharges).toFixed(2)),
      row.expectedOn ?? "",
      row.createdAt,
      String(receivedPercent(row)),
    ]);
    const csv = [header, ...rows]
      .map((cols) => cols.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `purchase-orders-${todayIsoDate()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const columns: Column<PurchaseOrderListItem>[] = useMemo(
    () => [
      {
        key: "poNumber",
        header: "PO number",
        getValue: (row) => row.poNumber,
        render: (row) => (
          <button type="button" className={css.poNumber} onClick={() => setDetailId(row.id)}>
            {row.poNumber}
          </button>
        ),
      },
      {
        key: "supplier",
        header: "Supplier",
        getValue: (row) => row.supplier.name,
        render: (row) => (
          <div className={css.supplierCell}>
            <span>{row.supplier.name}</span>
            <span className={css.supplierCode}>{row.supplier.code}</span>
          </div>
        ),
      },
      {
        key: "status",
        header: "Status",
        getValue: (row) => row.status,
        render: (row) => (
          <div className={css.statusCell}>
            <StatusBadge status={row.status} />
            {isPoOverdue(row) && <StatusBadge status="overdue" />}
          </div>
        ),
      },
      {
        key: "lines",
        header: "Lines / qty",
        render: (row) => (
          <span>
            {row.items.length} line{row.items.length === 1 ? "" : "s"} · {poLineCount(row.items)}{" "}
            units
          </span>
        ),
      },
      {
        key: "value",
        header: "Est. value",
        render: (row) => formatMoney(poEstimatedValue(row.items, row.shippingCharges)),
      },
      {
        key: "expectedOn",
        header: "Expected delivery",
        render: (row) => <span className={css.muted}>{formatDate(row.expectedOn)}</span>,
      },
      {
        key: "createdAt",
        header: "Created",
        render: (row) => <span className={css.muted}>{formatDate(row.createdAt)}</span>,
      },
      {
        key: "received",
        header: "Received %",
        render: (row) => {
          const pct = receivedPercent(row);
          const tone =
            pct >= 100 ? css.progressFillDone : pct > 0 ? css.progressFillWarn : "";
          return (
            <div className={css.receivedCell}>
              <span className={css.receivedMeta}>{pct}%</span>
              <div className={css.progressTrack} aria-hidden>
                <div
                  className={`${css.progressFill}${tone ? ` ${tone}` : ""}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        },
      },
      {
        key: "actions",
        header: "Actions",
        render: (row) => (
          <div className={css.actionsCell}>
            <button
              type="button"
              className={`${css.actionIcon} ${css.actionIconView}`}
              onClick={() => {
                setDetailStartInEdit(false);
                setDetailId(row.id);
              }}
              aria-label={`View ${row.poNumber}`}
              data-tooltip="View PO"
            >
              <IconEye size={17} />
            </button>
            {canWrite && (canEditPo(row.status) || canAdjustExpected(row.status)) && (
              <button
                type="button"
                className={`${css.actionIcon} ${css.actionIconEdit}`}
                onClick={() => {
                  setDetailStartInEdit(true);
                  setDetailId(row.id);
                }}
                aria-label={`Edit ${row.poNumber}`}
                data-tooltip="Edit PO"
              >
                <IconEdit size={17} />
              </button>
            )}
          </div>
        ),
      },
    ],
    [canWrite],
  );

  function clearPoParam() {
    if (!searchParams.get("po")) return;
    const next = new URLSearchParams(searchParams.toString());
    next.delete("po");
    const qs = next.toString();
    router.replace(qs ? `/purchasing?${qs}` : "/purchasing");
  }

  function clearCreateAction() {
    if (action !== "create-po" && !productId) return;
    const next = new URLSearchParams(searchParams.toString());
    next.delete("action");
    const qs = next.toString();
    router.replace(qs ? `/purchasing?${qs}` : "/purchasing");
  }

  return (
    <div className={css.page}>
      <ProductContextBanner />

      <PageHeader
        subtitleOnly
        floatingActions
        description="Create purchase orders, issue them to suppliers, receive goods into batch stock, and track procurement status."
        actions={
          canWrite ? (
            <ActionButton icon={<IconPlus size={16} />} onClick={() => setCreateOpen(true)}>
              New purchase order
            </ActionButton>
          ) : null
        }
      />

      {!orders.hasBranch && (
        <div className={css.branchNotice}>
          Select a branch in the header to manage purchase orders for that location.
        </div>
      )}

      {orders.hasBranch && (
        <div className={css.dashboard}>
          <div className={css.mainCol}>
            <div className={css.kpiRow}>
              <StatCard size="sm"
                title="Draft"
                value={summary.draft}
                subtitle="Not yet issued"
                icon={<IconClipboardList size={16} />}
                iconTone="info"
                active={statusFilter === "draft"}
                onClick={() => toggleStatus("draft")}
              />
              <StatCard size="sm"
                title="Pending approval"
                value={summary.pending_approval}
                subtitle="Awaiting approval"
                icon={<IconBell size={16} />}
                iconTone="warning"
                active={statusFilter === "pending_approval"}
                onClick={() => toggleStatus("pending_approval")}
              />
              <StatCard size="sm"
                title="Issued"
                value={summary.issued}
                subtitle="With suppliers"
                icon={<IconTruck size={16} />}
                iconTone="primary"
                active={statusFilter === "issued"}
                onClick={() => toggleStatus("issued")}
              />
              <StatCard size="sm"
                title="Partially received"
                value={summary.partially_received}
                subtitle="In progress"
                icon={<IconPackage size={16} />}
                iconTone="warning"
                active={statusFilter === "partially_received"}
                onClick={() => toggleStatus("partially_received")}
              />
              <StatCard size="sm"
                title="Received"
                value={summary.received}
                subtitle="Fully received"
                icon={<IconCheck size={16} />}
                iconTone="success"
                active={statusFilter === "received"}
                onClick={() => toggleStatus("received")}
              />
              <StatCard size="sm"
                title="Overdue"
                value={summary.overdue}
                subtitle="Past due date"
                icon={<IconCalendar size={16} />}
                iconTone="danger"
                active={statusFilter === "overdue"}
                onClick={() => toggleStatus("overdue")}
              />
            </div>

            <div className={css.toolbar}>
              <div className={css.searchWrap}>
                <IconSearch size={15} className={css.searchIcon} />
                <input
                  type="search"
                  className={css.searchInput}
                  placeholder="Search PO number, supplier, product…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <InventoryFilterSelect
                label="Status"
                value={statusFilter}
                options={STATUS_OPTIONS}
                onChange={(value) => setStatusFilter(value as PoStatusFilter)}
              />
              <InventoryFilterSelect
                label="Supplier"
                value={supplierFilter}
                options={supplierOptions}
                onChange={setSupplierFilter}
              />
              <InventoryFilterSelect
                label="Branch"
                value={branchId ?? ""}
                options={
                  branchOptions.length
                    ? branchOptions
                    : [{ value: branchId ?? "", label: "Current branch" }]
                }
                onChange={(value) => setBranchId(value)}
              />
              <div
                className={`${css.dateRange}${dateFrom || dateTo ? ` ${css.dateRangeFilled}` : ""}`}
                role="group"
                aria-label="Created date range"
              >
                <span className={css.dateRangeIcon} aria-hidden>
                  <IconCalendar size={14} />
                </span>
                <div className={css.dateRangeFields}>
                  <label className={css.dateRangeField}>
                    <span className={css.dateRangeLabel}>From</span>
                    <input
                      type="date"
                      value={dateFrom}
                      onChange={(e) => setDateFrom(e.target.value)}
                      aria-label="Created from"
                    />
                  </label>
                  <span className={css.dateRangeSep} aria-hidden>
                    →
                  </span>
                  <label className={css.dateRangeField}>
                    <span className={css.dateRangeLabel}>To</span>
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
                className={`${css.periodChip}${isThisMonthPreset ? ` ${css.periodChipActive}` : ""}`}
                onClick={toggleThisMonth}
                aria-pressed={isThisMonthPreset}
              >
                <IconCalendar size={13} />
                This month
              </button>
              <div className={css.toolbarSpacer} />
              <button type="button" className={css.actionBtn} onClick={exportCsv}>
                <IconDownload size={14} />
                Export
              </button>
            </div>

            {orders.error && <Alert variant="error">{orders.error}</Alert>}

            {filtersActive && (
              <div className={css.activeFilter}>
                <span>
                  Filtered purchase orders · {filtered.length} order
                  {filtered.length === 1 ? "" : "s"}
                </span>
                <button type="button" className={css.clearFilter} onClick={clearFilters}>
                  Clear filter
                </button>
              </div>
            )}

            <DataTable
              columns={columns}
              data={paged}
              rowKey={(r) => r.id}
              loading={orders.loading}
              page={page}
              pageSize={PAGE_SIZE}
              total={filtered.length}
              onPageChange={setPage}
              emptyTitle="No purchase orders match your filters"
              emptyDescription={
                canWrite
                  ? "Create a purchase order to order stock from a supplier"
                  : "Ask a manager or inventory clerk to create purchase orders"
              }
              emptyIcon={<IconClipboardList size={48} />}
              compact
            />
          </div>

          <aside className={css.sideCol}>
            <div className={css.sideCard}>
              <div className={inventoryCss.summaryHeader}>
                <h3 className={`${css.sideCardTitle} ${css.sideCardTitleFlush}`}>
                  Purchasing summary
                </h3>
                <InventoryFilterSelect
                  label="Period"
                  value={summaryPeriod}
                  options={SUMMARY_PERIOD_OPTIONS}
                  onChange={(value) => setSummaryPeriod(value as SummaryPeriod)}
                  portal
                />
              </div>
              <p className={css.periodLabel}>{summaryPeriodLabel}</p>
              <div className={css.summaryGrid}>
                <div className={css.summaryRow}>
                  <span>Total ordered</span>
                  <span className={css.summaryValue}>
                    {formatMoney(periodSummary.totalOrdered)}
                  </span>
                </div>
                <div className={css.summaryRow}>
                  <span>Total received</span>
                  <span className={css.summaryValue}>
                    {formatMoney(periodSummary.totalReceived)}
                  </span>
                </div>
                <div className={`${css.summaryRow} ${css.summaryHighlight}`}>
                  <span>Outstanding (on order)</span>
                  <span className={css.summaryValue}>
                    {formatMoney(periodSummary.outstanding)}
                  </span>
                </div>
              </div>
              <p className={css.fieldHint}>
                {periodSummary.orderCount} purchase order
                {periodSummary.orderCount === 1 ? "" : "s"} in period
              </p>
              <Link href="/inventory/movements?category=purchases" className={css.sideLink}>
                View purchase movements →
              </Link>
            </div>

            <div className={css.sideCard}>
              <h3 className={css.sideCardTitle}>Supplier alerts</h3>
              {alerts.length === 0 ? (
                <p className={css.fieldHint}>No supplier alerts right now.</p>
              ) : (
                <ul className={css.alertList}>
                  {alerts.map((alert) => (
                    <li key={alert.key}>
                      <button
                        type="button"
                        className={css.alertItem}
                        onClick={() => toggleStatus(alert.filter)}
                      >
                        <div className={css.alertItemLeft}>
                          <span
                            className={`${css.alertIcon} ${
                              alert.tone === "danger"
                                ? css.alertIconDanger
                                : alert.tone === "warning"
                                  ? css.alertIconWarning
                                  : css.alertIconInfo
                            }`}
                          >
                            <IconAlertTriangle size={12} />
                          </span>
                          <span className={css.alertText}>{alert.label}</span>
                        </div>
                        <span className={css.alertCount}>{alert.count}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {alerts.length > 0 && (
                <button
                  type="button"
                  className={css.sideLink}
                  onClick={() => toggleStatus(alerts[0].filter)}
                >
                  View top alert →
                </button>
              )}
            </div>

            <div className={css.sideCard}>
              <h3 className={css.sideCardTitle}>Related</h3>
              <ul className={css.quickList}>
                <li>
                  <button
                    type="button"
                    className={css.quickItem}
                    onClick={() => toggleStatus("receivable")}
                  >
                    <span className={css.quickIcon}>
                      <IconPackage size={14} />
                    </span>
                    Receive stock
                  </button>
                </li>
                <li>
                  <Link href="/inventory/movements?category=purchases" className={css.quickItem}>
                    <span className={css.quickIcon}>
                      <IconActivity size={14} />
                    </span>
                    Purchase movements
                  </Link>
                </li>
                <li>
                  <Link href="/inventory/batches" className={css.quickItem}>
                    <span className={css.quickIcon}>
                      <IconBox size={14} />
                    </span>
                    Inventory batches
                  </Link>
                </li>
                <li>
                  <Link href="/suppliers" className={css.quickItem}>
                    <span className={css.quickIcon}>
                      <IconTruck size={14} />
                    </span>
                    View suppliers
                  </Link>
                </li>
                <li>
                  <button
                    type="button"
                    className={css.quickItem}
                    onClick={() => toggleStatus("pending_approval")}
                  >
                    <span className={css.quickIcon}>
                      <IconBell size={14} />
                    </span>
                    Pending approvals
                  </button>
                </li>
              </ul>
            </div>
          </aside>
        </div>
      )}

      <CreatePoModal
        open={createOpen}
        initialProductId={productId}
        onClose={() => {
          setCreateOpen(false);
          clearCreateAction();
        }}
        onCreated={() => {
          void orders.reload();
        }}
      />

      <PoDetailModal
        poId={detailId}
        canWrite={canWrite}
        canCancelPo={canCancel}
        canApprovePo={canApprove}
        startInEdit={detailStartInEdit}
        onClose={() => {
          setDetailId(null);
          setDetailStartInEdit(false);
          clearPoParam();
        }}
        onChanged={() => void orders.reload()}
      />
    </div>
  );
}

export default function PurchasingPage() {
  return (
    <Suspense fallback={<div className={css.loading}>Loading purchasing…</div>}>
      <PurchasingContent />
    </Suspense>
  );
}
