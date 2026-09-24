"use client";

import Link from "next/link";
import { Suspense, useMemo, useState } from "react";
import { Alert } from "@/components/alert";
import {
  IconAlertTriangle,
  IconBox,
  IconDollarSign,
  IconDownload,
  IconPackage,
  IconSearch,
  IconTruck,
} from "@/components/icons";
import {
  ActiveFilterBanner,
  DataTable,
  DateRangeField,
  Modal,
  ModalButton,
  ModalFooter,
  PageHeader,
  StatCard,
  type Column,
  type FilterPill,
} from "@/components/ui";
import { InventoryFilterSelect } from "../../inventory/components/inventory-filter-select";
import { PurchasingSubnav } from "../components/purchasing-subnav";
import { useDeliveries } from "../hooks/use-deliveries";
import { usePurchasingAccess } from "../hooks/use-purchasing-access";
import { useSuppliers } from "../hooks/use-suppliers";
import css from "../purchasing.module.css";
import type { DeliveryRow } from "../types";
import { formatDate, formatMoney } from "../utils";

function DeliveriesContent() {
  const access = usePurchasingAccess();
  const suppliers = useSuppliers();
  const [search, setSearch] = useState("");
  const [supplierFilter, setSupplierFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [selected, setSelected] = useState<DeliveryRow | null>(null);
  const [flagFilter, setFlagFilter] = useState<"all" | "free" | "damaged">("all");

  const toggleFlag = (flag: "free" | "damaged") =>
    setFlagFilter((prev) => (prev === flag ? "all" : flag));

  const deliveries = useDeliveries({
    supplierId: supplierFilter === "all" ? undefined : supplierFilter,
    from: dateFrom || undefined,
    to: dateTo || undefined,
    q: search,
  });

  const supplierOptions = useMemo(
    () => [
      { value: "all", label: "All suppliers" },
      ...suppliers.rows.map((s) => ({ value: s.id, label: s.name })),
    ],
    [suppliers.rows],
  );

  const rows = useMemo(() => {
    if (flagFilter === "free") return deliveries.rows.filter((row) => row.freeUnits > 0);
    if (flagFilter === "damaged") return deliveries.rows.filter((row) => row.rejectedUnits > 0);
    return deliveries.rows;
  }, [deliveries.rows, flagFilter]);

  const totals = useMemo(() => {
    let units = 0;
    let free = 0;
    let damaged = 0;
    let value = 0;
    for (const row of deliveries.rows) {
      units += row.paidUnits;
      free += row.freeUnits;
      damaged += row.rejectedUnits;
      value += Number(row.value ?? 0);
    }
    return { count: deliveries.rows.length, units, free, damaged, value };
  }, [deliveries.rows]);

  const pills: FilterPill[] = [
    ...(supplierFilter !== "all"
      ? [
          {
            key: "supplier",
            label:
              supplierOptions.find((o) => o.value === supplierFilter)?.label ?? "Supplier",
          },
        ]
      : []),
    ...(dateFrom || dateTo
      ? [{ key: "dates", label: `${dateFrom || "any"} → ${dateTo || "today"}` }]
      : []),
    ...(search.trim() ? [{ key: "search", label: `“${search.trim()}”` }] : []),
    ...(flagFilter !== "all"
      ? [{ key: "flag", label: flagFilter === "free" ? "With free goods" : "With damaged units" }]
      : []),
  ];

  const clearFilters = () => {
    setSupplierFilter("all");
    setDateFrom("");
    setDateTo("");
    setSearch("");
    setFlagFilter("all");
  };

  function exportCsv() {
    const header = [
      "GRN",
      "Received on",
      "Supplier",
      "PO",
      "Lines",
      "Units",
      "Free",
      "Damaged",
      ...(access.canViewCost ? ["Value"] : []),
    ];
    const csvRows = rows.map((row) => [
      row.grnNumber,
      row.receivedOn,
      row.supplier.name,
      row.purchaseOrder.poNumber,
      String(row.lineCount),
      String(row.paidUnits),
      String(row.freeUnits),
      String(row.rejectedUnits),
      ...(access.canViewCost ? [row.value ?? ""] : []),
    ]);
    const csv = [header, ...csvRows]
      .map((cells) => cells.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `deliveries-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const columns: Column<DeliveryRow>[] = [
    {
      key: "grn",
      header: "Delivery",
      render: (row) => (
        <button
          type="button"
          className={css.linkLikeButton}
          onClick={() => setSelected(row)}
          aria-label={`Open delivery ${row.grnNumber}`}
        >
          {row.grnNumber}
        </button>
      ),
    },
    { key: "receivedOn", header: "Received", render: (row) => formatDate(row.receivedOn) },
    {
      key: "supplier",
      header: "Supplier",
      render: (row) => (
        <>
          <div>{row.supplier.name}</div>
          <div className={css.supplierCode}>{row.supplier.code}</div>
        </>
      ),
    },
    {
      key: "po",
      header: "Order",
      render: (row) => (
        <Link href={`/purchasing?po=${row.purchaseOrder.id}`} className={css.inlineLink}>
          {row.purchaseOrder.poNumber}
        </Link>
      ),
    },
    {
      key: "units",
      header: "Units",
      align: "right",
      render: (row) => (
        <>
          <div>{row.paidUnits.toLocaleString()}</div>
          {row.freeUnits > 0 || row.rejectedUnits > 0 ? (
            <div className={css.supplierCode}>
              {[
                row.freeUnits ? `${row.freeUnits} free` : null,
                row.rejectedUnits ? `${row.rejectedUnits} damaged` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
          ) : null}
        </>
      ),
    },
    { key: "receivedBy", header: "Received by", render: (row) => row.receivedBy?.fullName ?? "—" },
    ...(access.canViewCost
      ? [
          {
            key: "value",
            header: "Value",
            align: "right" as const,
            render: (row: DeliveryRow) => (row.value ? formatMoney(row.value) : "—"),
          },
        ]
      : []),
  ];

  return (
    <div className={css.page}>
      <PageHeader
        subtitleOnly
        floatingActions
        description="Every delivery booked in at this branch, with what arrived free, what arrived damaged, and which order it belongs to."
        actions={
          <button type="button" className={css.actionBtn} onClick={exportCsv}>
            <IconDownload size={14} />
            Export
          </button>
        }
      />

      <PurchasingSubnav />

      {!deliveries.hasBranch && (
        <div className={css.branchNotice}>
          Select a branch in the header to see deliveries for that location.
        </div>
      )}

      {deliveries.hasBranch && (
        <>
          <div className={css.kpiRow}>
            <StatCard
              size="sm"
              title="Deliveries"
              value={String(totals.count)}
              subtitle="In this view"
              icon={<IconTruck size={16} />}
              iconTone="primary"
              showMenu={false}
            />
            <StatCard
              size="sm"
              title="Units received"
              value={totals.units.toLocaleString()}
              subtitle="Billed units"
              icon={<IconPackage size={16} />}
              iconTone="info"
              showMenu={false}
            />
            <StatCard
              size="sm"
              title="Free units"
              value={totals.free.toLocaleString()}
              subtitle="At no charge"
              icon={<IconBox size={16} />}
              iconTone="success"
              active={flagFilter === "free"}
              onClick={() => toggleFlag("free")}
            />
            <StatCard
              size="sm"
              title="Damaged"
              value={totals.damaged.toLocaleString()}
              subtitle="Held in quarantine"
              icon={<IconAlertTriangle size={16} />}
              iconTone={totals.damaged > 0 ? "warning" : "info"}
              active={flagFilter === "damaged"}
              onClick={() => toggleFlag("damaged")}
            />
            {access.canViewCost && (
              <StatCard
                size="sm"
                title="Value"
                value={formatMoney(totals.value)}
                subtitle="Billed, before credits"
                icon={<IconDollarSign size={16} />}
                iconTone="primary"
                showMenu={false}
              />
            )}
          </div>

          <div className={css.toolbar}>
            <div className={css.searchWrap}>
              <IconSearch size={15} className={css.searchIcon} />
              <input
                type="search"
                className={css.searchInput}
                placeholder="Search GRN, PO or supplier…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <InventoryFilterSelect
              label="Supplier"
              value={supplierFilter}
              options={supplierOptions}
              onChange={setSupplierFilter}
            />
            <DateRangeField
              label="Received date range"
              from={dateFrom}
              to={dateTo}
              onFromChange={setDateFrom}
              onToChange={setDateTo}
            />
          </div>

          <ActiveFilterBanner
            active={pills.length > 0}
            summary={`Filtered deliveries · ${rows.length} result${rows.length === 1 ? "" : "s"}`}
            pills={pills}
            onClear={clearFilters}
          />

          {deliveries.error && <Alert variant="error">{deliveries.error}</Alert>}

          <DataTable
            columns={columns}
            data={rows}
            rowKey={(row) => row.id}
            loading={deliveries.loading}
            emptyIcon={<IconTruck size={22} />}
            emptyTitle="No deliveries yet"
            emptyDescription="Deliveries appear here once goods are booked in against a purchase order."
          />

          <Modal
            open={selected !== null}
            onClose={() => setSelected(null)}
            variant="sheet"
            title={selected?.grnNumber ?? "Delivery"}
            description={
              selected
                ? `${selected.supplier.name} · received ${formatDate(selected.receivedOn)}`
                : undefined
            }
            footer={
              <ModalFooter>
                <ModalButton onClick={() => setSelected(null)}>Done</ModalButton>
              </ModalFooter>
            }
          >
            {selected && (
              <div className={css.tableScroll}>
                <table className={css.suggestTable}>
                  <thead>
                    <tr>
                      <th scope="col">Product</th>
                      <th scope="col">Batch</th>
                      <th scope="col">Expiry</th>
                      <th scope="col">Received</th>
                      <th scope="col">Free</th>
                      <th scope="col">Damaged</th>
                      {access.canViewCost && <th scope="col">Unit cost</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {selected.items.map((item) => (
                      <tr key={item.id}>
                        <td>
                          <div className={css.cellStrong}>{item.product.name}</div>
                          <div className={css.supplierCode}>{item.product.sku}</div>
                        </td>
                        <td>{item.batch.batchNo}</td>
                        <td>{formatDate(item.batch.expiryDate)}</td>
                        <td>
                          {item.receivedQty}
                          {item.packs ? (
                            <div className={css.supplierCode}>{item.packs} packs</div>
                          ) : null}
                        </td>
                        <td>{item.freeQty || "—"}</td>
                        <td>{item.rejectedQty || "—"}</td>
                        {access.canViewCost && (
                          <td>{item.unitCost ? formatMoney(item.unitCost) : "—"}</td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Modal>
        </>
      )}
    </div>
  );
}

export default function DeliveriesPage() {
  return (
    <Suspense fallback={null}>
      <DeliveriesContent />
    </Suspense>
  );
}
