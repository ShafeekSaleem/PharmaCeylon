"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/alert";
import { IconReceipt, IconSearch } from "@/components/icons";
import {
  ActiveFilterBanner,
  DataTable,
  FilterChips,
  PageHeader,
  StatusBadge,
  rowMenuColumn,
  type Column,
  type FilterPill,
  type RowMenuAction,
} from "@/components/ui";
import { formatMoney } from "@/lib/money";
import { useAuth } from "@/lib/use-auth";
import type { SaleChannel } from "@pharmaceylon/shared";
import { InventoryFilterSelect } from "../inventory/components/inventory-filter-select";
import {
  SalesFilterPanel,
  salesPanelFiltersAreActive,
  salesPanelFiltersFrom,
  type SalesPanelFilters,
} from "./components/sales-filter-panel";
import {
  CHANNEL_CHIP_ORDER,
  CHANNEL_LABELS,
  DEFAULT_FILTERS,
  PAGE_SIZE,
  PAYMENT_METHOD_LABELS,
} from "./constants";
import { useSalesChannelCounts } from "./hooks/use-sales-channel-counts";
import { useSalesHistory, useSalesHistoryOptions } from "./hooks/use-sales-history";
import type { SaleListRow, SalesChannelChip, SalesFilters } from "./types";
import {
  DASH,
  channelLabel,
  formatDate,
  formatShiftRange,
  formatTime,
  paymentMethodsLabel,
  tillLabelFromRegister,
} from "./utils";
import css from "./sales.module.css";

function listStatusCell(status: SaleListRow["status"]) {
  if (status === "posted") return null;
  const variant = status === "voided" ? "danger" : "info";
  return <StatusBadge status={status} variant={variant} />;
}

function salesFiltersAreActive(filters: SalesFilters): boolean {
  return (
    salesPanelFiltersAreActive(salesPanelFiltersFrom(filters)) ||
    filters.channel !== "all" ||
    Boolean(filters.invoiceNo.trim())
  );
}

/**
 * Sales history for the back office (W4 #66 Phase B, filter option B): channel chips with
 * counts, receipt search with counter scope, and panel filters for counter/till/shift/staff/payment.
 */
export default function SalesHistory() {
  const router = useRouter();
  const { branchId } = useAuth();
  const [filters, setFilters] = useState<SalesFilters>(DEFAULT_FILTERS);
  const [invoiceInput, setInvoiceInput] = useState("");
  const [page, setPage] = useState(1);
  const [knownShifts, setKnownShifts] = useState<Map<string, { id: string; label: string }>>(new Map());

  const options = useSalesHistoryOptions();
  const history = useSalesHistory(filters, page, branchId);
  const channelCounts = useSalesChannelCounts(filters, branchId);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setFilters((f) => (f.invoiceNo === invoiceInput ? f : { ...f, invoiceNo: invoiceInput }));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [invoiceInput]);

  useEffect(() => {
    setPage(1);
  }, [filters, branchId]);

  useEffect(() => {
    setKnownShifts((prev) => {
      const next = new Map(prev);
      for (const row of history.items) {
        if (row.shift) {
          next.set(row.shift.id, { id: row.shift.id, label: formatShiftRange(row.shift) });
        }
      }
      return next;
    });
  }, [history.items]);

  const registerOptions = useMemo(
    () => [
      { value: "any", label: "Any counter" },
      ...options.registers.map((r) => ({ value: r.registerId, label: r.label })),
    ],
    [options.registers],
  );

  const sellerOptions = useMemo(
    () => [
      { value: "all", label: "All staff" },
      ...options.sellers.map((s) => ({ value: s.id, label: s.fullName })),
    ],
    [options.sellers],
  );

  const shiftOptions = useMemo(() => [...knownShifts.values()], [knownShifts]);

  const pills: FilterPill[] = [
    ...(filters.channel !== "all"
      ? [{ key: "channel", label: CHANNEL_LABELS[filters.channel as SaleChannel] }]
      : []),
    ...(filters.from || filters.to
      ? [
          {
            key: "date",
            label: `${filters.from ? formatDate(filters.from) : "Any"} → ${filters.to ? formatDate(filters.to) : "Any"}`,
          },
        ]
      : []),
    ...(filters.registerId !== "all"
      ? [
          {
            key: "counter",
            label:
              registerOptions.find((o) => o.value === filters.registerId)?.label ?? "Counter",
          },
        ]
      : []),
    ...(filters.tillId !== "all"
      ? [
          {
            key: "till",
            label:
              options.registers.find((r) => r.tillId === filters.tillId)?.label ??
              "Till",
          },
        ]
      : []),
    ...(filters.shiftId !== "all"
      ? [{ key: "shift", label: knownShifts.get(filters.shiftId)?.label ?? "Shift" }]
      : []),
    ...(filters.soldBy !== "all"
      ? [{ key: "staff", label: sellerOptions.find((o) => o.value === filters.soldBy)?.label ?? "Staff" }]
      : []),
    ...(filters.paymentMethod !== "all"
      ? [{ key: "payment", label: PAYMENT_METHOD_LABELS[filters.paymentMethod] }]
      : []),
    ...(filters.invoiceNo.trim()
      ? [{ key: "invoice", label: `Receipt: ${filters.invoiceNo.trim()}` }]
      : []),
    ...(filters.receiptCounterScope !== "any" && filters.invoiceNo.trim()
      ? [
          {
            key: "scope",
            label:
              registerOptions.find((o) => o.value === filters.receiptCounterScope)?.label ??
              "Counter scope",
          },
        ]
      : []),
  ];
  const filtered = salesFiltersAreActive(filters);

  function clearFilters() {
    setInvoiceInput("");
    setFilters(DEFAULT_FILTERS);
  }

  function applyPanel(panel: SalesPanelFilters) {
    setFilters((f) => ({ ...f, ...panel }));
  }

  function clearPanel() {
    setFilters((f) => ({
      ...f,
      ...salesPanelFiltersFrom(DEFAULT_FILTERS),
    }));
  }

  const rowActions = (row: SaleListRow): RowMenuAction[] => [
    { label: "View sale", onClick: () => router.push(`/sales/${row.id}`) },
    {
      label: "Prepare refund",
      onClick: () => router.push(`/sales/${row.id}`),
    },
  ];

  const columns: Column<SaleListRow>[] = [
    {
      key: "receipt",
      header: "Receipt",
      width: "11rem",
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
      width: "8.5rem",
      render: (row) => (
        <span className={css.cellStack}>
          <span>{formatDate(row.soldAt)}</span>
          <span className={css.cellSub}>{formatTime(row.soldAt)}</span>
        </span>
      ),
    },
    {
      key: "counter",
      header: "Counter",
      width: "7.5rem",
      render: (row) => row.register?.label ?? DASH,
    },
    {
      key: "till",
      header: "Till",
      width: "6.5rem",
      render: (row) => (row.register ? tillLabelFromRegister(row.register) : DASH),
    },
    {
      key: "shift",
      header: "Shift",
      width: "8.5rem",
      render: (row) => (row.shift ? formatShiftRange(row.shift) : DASH),
    },
    {
      key: "channel",
      header: "Channel",
      width: "7rem",
      render: (row) => channelLabel(row.channel),
    },
    {
      key: "seller",
      header: "Sold by",
      width: "9rem",
      render: (row) => row.sellerName,
    },
    {
      key: "payment",
      header: "Payment",
      width: "8.5rem",
      render: (row) => paymentMethodsLabel(row.paymentMethods),
    },
    {
      key: "grandTotal",
      header: "Total",
      width: "8.5rem",
      align: "right",
      render: (row) => <span className={css.amount}>{formatMoney(row.grandTotal)}</span>,
    },
    {
      key: "status",
      header: "Status",
      width: "8rem",
      render: (row) => listStatusCell(row.status),
    },
    rowMenuColumn(rowActions, (row) => row.invoiceNo),
  ];

  const activeChannelChip: SalesChannelChip = filters.channel;

  return (
    <div className={css.page}>
      <PageHeader
        subtitleOnly
        description="Every sale at this branch, newest first. Open one for its items, payments and a receipt copy."
      />

      {history.error ? <Alert variant="error">{history.error}</Alert> : null}

      <div className={css.listToolbar}>
        <FilterChips<SalesChannelChip>
          label="Sales channel"
          chips={CHANNEL_CHIP_ORDER.map((id) => ({
            id,
            label: id === "all" ? "All" : CHANNEL_LABELS[id],
            count: channelCounts[id],
          }))}
          active={activeChannelChip}
          onChange={(id) => setFilters((f) => ({ ...f, channel: id }))}
        />

        <div className={css.receiptSearch} role="search">
          <div className={css.receiptSearchField}>
            <IconSearch size={15} className={css.searchIcon} aria-hidden />
            <input
              type="search"
              className={css.receiptSearchInput}
              value={invoiceInput}
              onChange={(e) => setInvoiceInput(e.target.value)}
              placeholder="Receipt or invoice number"
              aria-label="Search by receipt or invoice number"
            />
          </div>
          <div className={css.receiptScope}>
            <InventoryFilterSelect
              label="Counter scope"
              value={filters.receiptCounterScope}
              options={registerOptions}
              className={css.receiptScopeSelect}
              onChange={(v) =>
                setFilters((f) => ({ ...f, receiptCounterScope: v || "any" }))
              }
            />
          </div>
        </div>

        <SalesFilterPanel
          applied={salesPanelFiltersFrom(filters)}
          options={options}
          shiftOptions={shiftOptions}
          onApply={applyPanel}
          onClear={clearPanel}
        />
      </div>

      <ActiveFilterBanner
        active={filtered}
        summary={`Filtered · ${history.total} sale${history.total === 1 ? "" : "s"}`}
        pills={pills}
        onClear={clearFilters}
        clearTooltip="Clear all filters"
      />

      <div className={css.tableStage}>
        <DataTable
          variant="list"
          minTableWidth="1100px"
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
          stickyHeader
          emptyIcon={<IconReceipt size={40} />}
          emptyTitle={filtered ? "No sales match these filters" : "No sales yet"}
          emptyDescription={
            filtered
              ? "Try a wider date range, or clear the filters."
              : "Sales rung up at the counter appear here."
          }
        />
        {history.loading ? (
          <p className={css.loadingFoot} role="status">
            Loading sales…
          </p>
        ) : null}
      </div>
    </div>
  );
}