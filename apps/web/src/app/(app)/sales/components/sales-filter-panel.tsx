"use client";

import { useEffect, useMemo, useState } from "react";
import { DateRangeField, FilterPopover, FilterRow } from "@/components/ui";
import { InventoryFilterSelect } from "../../inventory/components/inventory-filter-select";
import { DEFAULT_FILTERS, offlineSyncFilterOptions, PAYMENT_METHOD_OPTIONS } from "../constants";
import { shiftOptionLabel, shiftsForPicker } from "../shift-options";
import {
  counterFilterOptions,
  hasTillFilterOptions,
  tillFilterOptions,
  type RegisterPickOption,
} from "../register-options";
import type { SalesFilters, SalesHistoryOptions, SalesHistoryShiftOption } from "../types";
import css from "../sales.module.css";

export type SalesPanelFilters = Pick<
  SalesFilters,
  "from" | "to" | "soldBy" | "paymentMethod" | "registerId" | "tillId" | "shiftId" | "offlineSyncState"
>;

export function salesPanelFiltersAreActive(filters: SalesPanelFilters): boolean {
  return (
    Boolean(filters.from || filters.to) ||
    filters.soldBy !== "all" ||
    filters.paymentMethod !== "all" ||
    filters.registerId !== "all" ||
    filters.tillId !== "all" ||
    filters.shiftId !== "all" ||
    filters.offlineSyncState !== "all"
  );
}

export function salesPanelFiltersFrom(filters: SalesFilters): SalesPanelFilters {
  return {
    from: filters.from,
    to: filters.to,
    soldBy: filters.soldBy,
    paymentMethod: filters.paymentMethod,
    registerId: filters.registerId,
    tillId: filters.tillId,
    shiftId: filters.shiftId,
    offlineSyncState: filters.offlineSyncState,
  };
}

type Props = {
  applied: SalesPanelFilters;
  options: SalesHistoryOptions;
  registerPicks: RegisterPickOption[];
  branchId: string | null;
  onApply: (next: SalesPanelFilters) => void;
  onClear: () => void;
};

export function SalesFilterPanel({
  applied,
  options,
  registerPicks,
  branchId,
  onApply,
  onClear,
}: Props) {
  const [draft, setDraft] = useState(applied);

  useEffect(() => {
    setDraft(applied);
  }, [applied]);

  const sellerOptions = useMemo(
    () => [
      { value: "all", label: "All staff" },
      ...options.sellers.map((s) => ({ value: s.id, label: s.fullName })),
    ],
    [options.sellers],
  );

  const counterOptions = useMemo(
    () => counterFilterOptions(registerPicks, "All counters"),
    [registerPicks],
  );

  const tillOptions = useMemo(() => tillFilterOptions(registerPicks), [registerPicks]);
  const showTillFilter = hasTillFilterOptions(registerPicks);

  const shiftOptions: SalesHistoryShiftOption[] = useMemo(
    () => shiftsForPicker(options.shifts ?? [], branchId),
    [options.shifts, branchId],
  );
  const shiftSelectOptions = useMemo(
    () => [
      { value: "all", label: "All shifts" },
      ...shiftOptions.map((s) => ({
        value: s.shiftId,
        label: shiftOptionLabel(s, branchId, options.branches),
      })),
    ],
    [shiftOptions, branchId, options.branches],
  );
  const showShiftFilter = shiftOptions.length > 0;
  const syncOptions = useMemo(
    () => offlineSyncFilterOptions(options.offlineSyncStates),
    [options.offlineSyncStates],
  );

  const active = salesPanelFiltersAreActive(applied);

  return (
    <FilterPopover
      active={active}
      triggerLabel="Filters"
      panelTitle="Filters"
      panelAriaLabel="Sales filters"
    >
      <FilterRow
        label="Sale dates"
        hasSelection={Boolean(draft.from || draft.to)}
        onClear={() => setDraft((d) => ({ ...d, from: "", to: "" }))}
      >
        <DateRangeField
          label="Sale dates"
          from={draft.from}
          to={draft.to}
          onFromChange={(from) => setDraft((d) => ({ ...d, from }))}
          onToChange={(to) => setDraft((d) => ({ ...d, to }))}
        />
      </FilterRow>

      <FilterRow
        label="Counter"
        hasSelection={draft.registerId !== "all"}
        onClear={() => setDraft((d) => ({ ...d, registerId: "all" }))}
      >
        <InventoryFilterSelect
          label="Counter"
          value={draft.registerId}
          options={counterOptions}
          onChange={(v) => setDraft((d) => ({ ...d, registerId: v || "all" }))}
        />
      </FilterRow>

      {showTillFilter ? (
        <FilterRow
          label="Till"
          hasSelection={draft.tillId !== "all"}
          onClear={() => setDraft((d) => ({ ...d, tillId: "all" }))}
        >
          <InventoryFilterSelect
            label="Till"
            value={draft.tillId}
            options={tillOptions}
            onChange={(v) => setDraft((d) => ({ ...d, tillId: v || "all" }))}
          />
        </FilterRow>
      ) : null}

      {showShiftFilter ? (
        <FilterRow
          label="Shift"
          hasSelection={draft.shiftId !== "all"}
          onClear={() => setDraft((d) => ({ ...d, shiftId: "all" }))}
        >
          <InventoryFilterSelect
            label="Shift"
            value={draft.shiftId}
            options={shiftSelectOptions}
            onChange={(v) => setDraft((d) => ({ ...d, shiftId: v || "all" }))}
          />
        </FilterRow>
      ) : null}

      <FilterRow
        label="Sold by"
        hasSelection={draft.soldBy !== "all"}
        onClear={() => setDraft((d) => ({ ...d, soldBy: "all" }))}
      >
        <InventoryFilterSelect
          label="Staff"
          value={draft.soldBy}
          options={sellerOptions}
          searchable
          searchPlaceholder="Find a person…"
          onChange={(v) => setDraft((d) => ({ ...d, soldBy: v || "all" }))}
        />
      </FilterRow>

      <FilterRow
        label="Payment"
        hasSelection={draft.paymentMethod !== "all"}
        onClear={() => setDraft((d) => ({ ...d, paymentMethod: "all" }))}
      >
        <InventoryFilterSelect
          label="Payment"
          value={draft.paymentMethod}
          options={PAYMENT_METHOD_OPTIONS}
          onChange={(v) =>
            setDraft((d) => ({
              ...d,
              paymentMethod: (v || "all") as SalesFilters["paymentMethod"],
            }))
          }
        />
      </FilterRow>

      <FilterRow
        label="Sync"
        hasSelection={draft.offlineSyncState !== "all"}
        onClear={() => setDraft((d) => ({ ...d, offlineSyncState: "all" }))}
      >
        <InventoryFilterSelect
          label="Sync"
          value={draft.offlineSyncState}
          options={syncOptions}
          onChange={(v) =>
            setDraft((d) => ({
              ...d,
              offlineSyncState: (v || "all") as SalesFilters["offlineSyncState"],
            }))
          }
        />
      </FilterRow>

      <div className={css.filterPanelActions}>
        <button
          type="button"
          className={css.filterPanelGhost}
          onClick={() => {
            setDraft(salesPanelFiltersFrom(DEFAULT_FILTERS));
            onClear();
          }}
        >
          Clear
        </button>
        <button type="button" className={css.filterPanelApply} onClick={() => onApply(draft)}>
          Apply
        </button>
      </div>
    </FilterPopover>
  );
}