"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/alert";
import { IconReceipt, IconSearch } from "@/components/icons";
import {
  ActiveFilterBanner,
  DataTable,
  FilterChips,
  PageHeader,
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
  BRANCH_SCOPED_FILTER_DEFAULTS,
  CHANNEL_CHIP_ORDER,
  CHANNEL_LABELS,
  DEFAULT_FILTERS,
  offlineSyncFilterOptions,
  PAGE_SIZE,
  PAYMENT_METHOD_LABELS,
} from "./constants";
import { EllipsisTip } from "./ellipsis-tip";
import { offlineSyncBadge, saleStatusBadge } from "./sync-badges";
import { useSalesChannelCounts } from "./hooks/use-sales-channel-counts";
import { useSalesHistory, useSalesHistoryOptions } from "./hooks/use-sales-history";
import { receiptScopeOptions, registersForPicker, tillLabelForId, type RegisterPickOption } from "./register-options";
import { shiftOptionLabel, shiftsForPicker } from "./shift-options";
import { saleTillCell } from "./till-display";
import type { SaleListRow, SalesChannelChip, SalesFilters } from "./types";
import {
  DASH,
  channelLabel,
  formatDate,
  formatShiftDetail,
  formatShiftRange,
  formatTime,
  paymentMethodsLabel,
} from "./utils";
import css from "./sales.module.css";

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
  const options = useSalesHistoryOptions();
  const history = useSalesHistory(filters, page, branchId);
  const channelCounts = useSalesChannelCounts(filters, branchId);
  const prevBranchId = useRef<string | null>(null);

  const registerPicks = useMemo(
    () => registersForPicker(options.registers, branchId, options.branches),
    [options.registers, options.branches, branchId],
  );

  const counterScopeOptions = useMemo(() => receiptScopeOptions(registerPicks), [registerPicks]);

  const registerPicksById = useMemo(() => {
    const map = new Map<string, RegisterPickOption>();
    for (const pick of registerPicks) map.set(pick.registerId, pick);
    return map;
  }, [registerPicks]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setFilters((f) => (f.invoiceNo === invoiceInput ? f : { ...f, invoiceNo: invoiceInput }));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [invoiceInput]);

  useEffect(() => {
    if (prevBranchId.current !== null && prevBranchId.current !== branchId) {
      setFilters((f) => ({ ...f, ...BRANCH_SCOPED_FILTER_DEFAULTS }));
    }
    prevBranchId.current = branchId;
    setPage(1);
  }, [branchId]);

  useEffect(() => {
    setPage(1);
  }, [filters]);

  const panelCounterActive = filters.registerId !== "all";
  const shiftOptions = useMemo(
    () => shiftsForPicker(options.shifts ?? [], branchId),
    [options.shifts, branchId],
  );

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
            label: registerPicksById.get(filters.registerId)?.counterLabel ?? "Counter",
          },
        ]
      : []),
    ...(filters.tillId !== "all"
      ? [
          {
            key: "till",
            label: tillLabelForId(filters.tillId, registerPicks) ?? "Till",
          },
        ]
      : []),
    ...(filters.shiftId !== "all" && shiftOptions.length > 0
      ? [
          {
            key: "shift",
            label:
              shiftOptions
                .filter((s) => s.shiftId === filters.shiftId)
                .map((s) => shiftOptionLabel(s, branchId, options.branches))[0] ?? "Shift",
          },
        ]
      : []),
    ...(filters.soldBy !== "all"
      ? [
          {
            key: "staff",
            label:
              [{ value: "all", label: "All staff" }, ...options.sellers.map((s) => ({
                value: s.id,
                label: s.fullName,
              }))].find((o) => o.value === filters.soldBy)?.label ?? "Staff",
          },
        ]
      : []),
    ...(filters.paymentMethod !== "all"
      ? [{ key: "payment", label: PAYMENT_METHOD_LABELS[filters.paymentMethod] }]
      : []),
    ...(filters.offlineSyncState !== "all"
      ? [
          {
            key: "sync",
            label:
              offlineSyncFilterOptions(options.offlineSyncStates).find(
                (o) => o.value === filters.offlineSyncState,
              )?.label ?? "Sync",
          },
        ]
      : []),
    ...(filters.invoiceNo.trim()
      ? [{ key: "invoice", label: `Receipt: ${filters.invoiceNo.trim()}` }]
      : []),
    ...(filters.receiptCounterScope !== "any" &&
    filters.invoiceNo.trim() &&
    !panelCounterActive
      ? [
          {
            key: "scope",
            label:
              counterScopeOptions.find((o) => o.value === filters.receiptCounterScope)?.label ??
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
    setFilters((f) => ({
      ...f,
      ...panel,
      receiptCounterScope: panel.registerId !== "all" ? "any" : f.receiptCounterScope,
    }));
  }

  function clearPanel() {
    setFilters((f) => ({
      ...f,
      ...salesPanelFiltersFrom(DEFAULT_FILTERS),
      receiptCounterScope: "any",
    }));
  }

  const rowActions = (row: SaleListRow): RowMenuAction[] => [
    { label: "View sale", onClick: () => router.push(`/sales/${row.id}`) },
    {
      label: "Receipt copy",
      onClick: () => router.push(`/sales/${row.id}?receipt=1`),
    },
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
      render: (row) => saleTillCell(row),
    },
    {
      key: "shift",
      header: "Shift",
      width: "8.5rem",
      render: (row) => {
        const text = row.shift ? formatShiftDetail(row.shift) : DASH;
        return row.shift ? (
          <EllipsisTip text={text}>
            <span className={css.cellStack}>
              <span>{formatShiftRange(row.shift)}</span>
            </span>
          </EllipsisTip>
        ) : (
          DASH
        );
      },
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
      render: (row) => <EllipsisTip text={row.sellerName} />,
    },
    {
      key: "payment",
      header: "Payment",
      width: "8.5rem",
      render: (row) => {
        const label = paymentMethodsLabel(row.paymentMethods);
        return label === DASH ? DASH : <EllipsisTip text={label} />;
      },
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
      width: "10.75rem",
      render: (row) => saleStatusBadge(row.status),
    },
    {
      key: "sync",
      header: "Sync",
      width: "9.25rem",
      render: (row) => offlineSyncBadge(row.offlineSyncState ?? null, "list"),
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
              options={counterScopeOptions}
              className={css.receiptScopeSelect}
              disabled={panelCounterActive}
              onChange={(v) =>
                setFilters((f) => ({ ...f, receiptCounterScope: v || "any" }))
              }
            />
          </div>
        </div>

        <SalesFilterPanel
          applied={salesPanelFiltersFrom(filters)}
          options={options}
          registerPicks={registerPicks}
          branchId={branchId}
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
        {history.error ? null : (
          <DataTable
            variant="list"
            minTableWidth="1200px"
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
        )}
        {history.loading ? (
          <p className={css.loadingFoot} role="status">
            Loading sales…
          </p>
        ) : null}
      </div>
    </div>
  );
}
