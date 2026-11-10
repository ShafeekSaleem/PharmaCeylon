"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/alert";
import { IconReceipt, IconSearch } from "@/components/icons";
import {
  ActiveFilterBanner,
  DataTable,
  DateRangeField,
  PageHeader,
  StatusBadge,
  type Column,
  type FilterPill,
} from "@/components/ui";
import { formatMoney } from "@/lib/money";
import { useAuth } from "@/lib/use-auth";
import { InventoryFilterSelect } from "../inventory/components/inventory-filter-select";
import { DEFAULT_FILTERS, PAGE_SIZE, PAYMENT_METHOD_LABELS, PAYMENT_METHOD_OPTIONS } from "./constants";
import { useSalesHistory, useSalesHistoryOptions } from "./hooks/use-sales-history";
import type { SaleListRow, SalesFilters } from "./types";
import { formatDate, formatTime, localDateKey, paymentMethodsLabel } from "./utils";
import css from "./sales.module.css";

/**
 * Sales history for the back office: every sale at the branches the caller may view, paged and
 * filtered on the server, each opening its detail and a receipt copy. Read-only — ringing up,
 * voiding and refunding stay at the counter.
 */
export default function SalesPage() {
  const router = useRouter();
  const { branchId } = useAuth();
  const [filters, setFilters] = useState<SalesFilters>(DEFAULT_FILTERS);
  const [invoiceInput, setInvoiceInput] = useState("");
  const [page, setPage] = useState(1);
  const options = useSalesHistoryOptions();
  const history = useSalesHistory(filters, page, branchId);

  // Typing an invoice number shouldn't send a request per keystroke.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setFilters((f) => (f.invoiceNo === invoiceInput ? f : { ...f, invoiceNo: invoiceInput }));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [invoiceInput]);

  useEffect(() => {
    setPage(1);
  }, [filters, branchId]);

  const activeBranchName = options.branches.find((b) => b.id === branchId)?.name;
  const branchOptions = useMemo(
    () => [
      { value: "current", label: activeBranchName ? `This branch (${activeBranchName})` : "This branch" },
      ...(options.branches.length > 1 ? [{ value: "all", label: "All my branches" }] : []),
      ...options.branches.filter((b) => b.id !== branchId).map((b) => ({ value: b.id, label: b.name })),
    ],
    [activeBranchName, branchId, options.branches],
  );
  const sellerOptions = useMemo(
    () => [
      { value: "all", label: "All staff" },
      ...options.sellers.map((s) => ({ value: s.id, label: s.fullName })),
    ],
    [options.sellers],
  );

  const today = localDateKey();
  const todayOnly = filters.from === today && filters.to === today;
  const showBranch = filters.branch !== "current";

  const pills: FilterPill[] = [
    ...(filters.branch !== "current"
      ? [{ key: "branch", label: branchOptions.find((o) => o.value === filters.branch)?.label ?? "Branch" }]
      : []),
    ...(filters.from || filters.to
      ? [
          {
            key: "date",
            label: todayOnly
              ? "Today"
              : `${filters.from ? formatDate(filters.from) : "Any"} → ${filters.to ? formatDate(filters.to) : "Any"}`,
          },
        ]
      : []),
    ...(filters.soldBy !== "all"
      ? [{ key: "staff", label: sellerOptions.find((o) => o.value === filters.soldBy)?.label ?? "Staff" }]
      : []),
    ...(filters.paymentMethod !== "all"
      ? [{ key: "payment", label: PAYMENT_METHOD_LABELS[filters.paymentMethod] }]
      : []),
    ...(filters.invoiceNo.trim() ? [{ key: "invoice", label: `Invoice: ${filters.invoiceNo.trim()}` }] : []),
  ];
  const filtered = pills.length > 0;

  function clearFilters() {
    setInvoiceInput("");
    setFilters(DEFAULT_FILTERS);
  }

  const columns: Column<SaleListRow>[] = [
    {
      key: "invoiceNo",
      header: "Invoice",
      width: "14rem",
      render: (row) => (
        <span className={css.cellStack}>
          <span className={css.cellMain}>{row.invoiceNo}</span>
          <span className={css.cellSub} title={row.summary}>
            {row.summary || `${row.itemCount} item${row.itemCount === 1 ? "" : "s"}`}
          </span>
        </span>
      ),
    },
    {
      key: "soldAt",
      header: "Date",
      width: "9rem",
      render: (row) => (
        <span className={css.cellStack}>
          <span>{formatDate(row.soldAt)}</span>
          <span className={css.cellSub}>{formatTime(row.soldAt)}</span>
        </span>
      ),
    },
    ...(showBranch
      ? [
          {
            key: "branch",
            header: "Branch",
            width: "9rem",
            render: (row: SaleListRow) => row.branch.name,
          },
        ]
      : []),
    {
      key: "customer",
      header: "Customer",
      render: (row) => row.customerName ?? <span className={css.muted}>Walk-in</span>,
    },
    {
      key: "seller",
      header: "Sold by",
      width: "10rem",
      render: (row) => row.sellerName,
    },
    {
      key: "payment",
      header: "Payment",
      width: "9rem",
      render: (row) => paymentMethodsLabel(row.paymentMethods),
    },
    {
      key: "grandTotal",
      header: "Total",
      width: "9rem",
      align: "right",
      render: (row) => <span className={css.amount}>{formatMoney(row.grandTotal)}</span>,
    },
    {
      key: "status",
      header: "Status",
      width: "9.5rem",
      render: (row) => <StatusBadge status={row.status} label={row.status === "posted" ? "Completed" : undefined} />,
    },
  ];

  return (
    <div className={css.page}>
      <PageHeader
        subtitleOnly
        description="Every sale at the branches you can view, newest first. Open one for its items, payments and a receipt copy."
      />

      {history.error ? <Alert variant="error">{history.error}</Alert> : null}

      <div className={css.toolbar}>
        <div className={css.searchWrap}>
          <IconSearch size={15} className={css.searchIcon} />
          <input
            type="search"
            className={css.searchInput}
            value={invoiceInput}
            onChange={(e) => setInvoiceInput(e.target.value)}
            placeholder="Invoice number…"
            aria-label="Search by invoice number"
          />
        </div>
        <InventoryFilterSelect
          label="Branch"
          value={filters.branch}
          options={branchOptions}
          onChange={(v) => setFilters((f) => ({ ...f, branch: v || "current" }))}
        />
        <InventoryFilterSelect
          label="Staff"
          value={filters.soldBy}
          options={sellerOptions}
          searchable
          searchPlaceholder="Find a person…"
          onChange={(v) => setFilters((f) => ({ ...f, soldBy: v || "all" }))}
        />
        <InventoryFilterSelect
          label="Payment"
          value={filters.paymentMethod}
          options={PAYMENT_METHOD_OPTIONS}
          onChange={(v) =>
            setFilters((f) => ({ ...f, paymentMethod: (v || "all") as SalesFilters["paymentMethod"] }))
          }
        />
        <button
          type="button"
          className={css.quickRange}
          aria-pressed={todayOnly}
          onClick={() =>
            setFilters((f) => (todayOnly ? { ...f, from: "", to: "" } : { ...f, from: today, to: today }))
          }
        >
          Today
        </button>
        <DateRangeField
          label="Sale dates"
          from={filters.from}
          to={filters.to}
          onFromChange={(from) => setFilters((f) => ({ ...f, from }))}
          onToChange={(to) => setFilters((f) => ({ ...f, to }))}
        />
      </div>

      <ActiveFilterBanner
        active={filtered}
        summary={`Filtered · ${history.total} sale${history.total === 1 ? "" : "s"}`}
        pills={pills}
        onClear={clearFilters}
        clearTooltip="Show this branch's sales again"
      />

      <DataTable
        columns={columns}
        data={history.items}
        rowKey={(row) => row.id}
        loading={history.loading}
        page={page}
        pageSize={PAGE_SIZE}
        total={history.total}
        onPageChange={setPage}
        onRowClick={(row) => router.push(`/sales/${row.id}`)}
        fixedLayout
        emptyIcon={<IconReceipt size={40} />}
        emptyTitle={filtered ? "No sales match these filters" : "No sales yet"}
        emptyDescription={
          filtered ? "Try a wider date range, or clear the filters." : "Sales rung up at the counter appear here."
        }
      />
    </div>
  );
}
