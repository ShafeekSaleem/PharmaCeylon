"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/alert";
import {
  IconAlertTriangle,
  IconCalendar,
  IconCheck,
  IconDownload,
  IconPackage,
  IconPlus,
  IconSearch,
} from "@/components/icons";
import { ProductContextBanner } from "@/components/product-context-banner";
import { ActionButton, PageHeader, StatCard } from "@/components/ui";
import { useAuth } from "@/lib/use-auth";
import { BatchesTable } from "../components/batches-table";
import { InventoryFilterSelect } from "../components/inventory-filter-select";
import { useInventoryBatches } from "../hooks/use-inventory-batches";
import css from "../inventory.module.css";
import type { ExpiryFilter } from "../types";
import { hasInventoryWriteAccess } from "../utils";

function BatchesContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const productId = searchParams.get("productId");
  const nearExpiryParam = searchParams.get("nearExpiryDays");
  const nearExpiryDays = (() => {
    if (!nearExpiryParam) return null;
    const n = Number(nearExpiryParam);
    return Number.isFinite(n) && n > 0 ? n : null;
  })();
  const { user, branchId } = useAuth();
  const canWrite = hasInventoryWriteAccess(user, branchId);

  const [search, setSearch] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [page, setPage] = useState(1);
  const [expiryFilter, setExpiryFilter] = useState<ExpiryFilter>(
    nearExpiryDays != null ? "near" : "all",
  );
  const [includeZero, setIncludeZero] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [debouncedQ, expiryFilter, includeZero, productId, nearExpiryDays]);

  const batches = useInventoryBatches({
    productId,
    nearExpiryDays,
    includeZero: true,
    q: debouncedQ,
  });

  const scopedRows = useMemo(
    () =>
      includeZero
        ? batches.rows
        : batches.rows.filter((batch) => batch.qtyOnHand > 0),
    [batches.rows, includeZero],
  );

  const rows = useMemo(() => {
    let list = scopedRows;
    if (expiryFilter === "near") {
      list = list.filter((b) => b.nearExpiry && !b.expired);
    } else if (expiryFilter === "expired") {
      list = list.filter((b) => b.expired);
    } else if (expiryFilter === "ok") {
      list = list.filter((b) => !b.expired && !b.nearExpiry);
    }
    return list;
  }, [scopedRows, expiryFilter]);

  const summary = useMemo(
    () => ({
      total: scopedRows.length,
      units: scopedRows.reduce((sum, batch) => sum + batch.qtyOnHand, 0),
      near: scopedRows.filter((batch) => batch.nearExpiry && !batch.expired).length,
      expired: scopedRows.filter((batch) => batch.expired).length,
      healthy: scopedRows.filter((batch) => !batch.expired && !batch.nearExpiry)
        .length,
      zero: batches.rows.filter((batch) => batch.qtyOnHand === 0).length,
    }),
    [scopedRows, batches.rows],
  );

  const exportRows = () => {
    const escapeCsv = (value: string | number) => {
      const text = String(value);
      return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    };
    const csv = [
      ["Product", "SKU", "Batch", "Expiry", "On hand", "Cost", "Selling price"],
      ...rows.map((batch) => [
        batch.product.name,
        batch.product.sku,
        batch.batchNo,
        batch.expiryDate,
        batch.qtyOnHand,
        batch.costPrice,
        batch.sellingPrice,
      ]),
    ]
      .map((line) => line.map(escapeCsv).join(","))
      .join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `inventory-batches-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <ProductContextBanner />
      <PageHeader
        subtitleOnly
        floatingActions
        description="Batch-level stock ordered by expiry (FEFO). Filter near-expiry and zero-qty lots."
        actions={
          canWrite ? (
            <ActionButton
              icon={<IconPlus size={16} />}
              tooltip="Post a stock quantity correction"
              onClick={() =>
                router.push(
                  `/inventory/adjustments${productId ? `?productId=${productId}` : ""}`,
                )
              }
            >
              New adjustment
            </ActionButton>
          ) : null
        }
      />

      {!batches.hasBranch && (
        <div className={css.branchNotice}>
          Select a branch in the header to view batch stock for that location.
        </div>
      )}

      {batches.hasBranch && (
        <div className={css.batchKpiRow}>
          <StatCard
            title="Active batches"
            value={summary.total}
            subtitle={`${summary.units} units on hand`}
            icon={<IconPackage size={16} />}
            iconTone="primary"
            active={expiryFilter === "all"}
            onClick={() => setExpiryFilter("all")}
          />
          <StatCard
            title="Healthy expiry"
            value={summary.healthy}
            subtitle="Outside 30 days"
            icon={<IconCheck size={16} />}
            iconTone="success"
            active={expiryFilter === "ok"}
            onClick={() => setExpiryFilter("ok")}
          />
          <StatCard
            title="Expiring soon"
            value={summary.near}
            subtitle="Within 30 days"
            icon={<IconCalendar size={16} />}
            iconTone="warning"
            active={expiryFilter === "near"}
            onClick={() => setExpiryFilter("near")}
          />
          <StatCard
            title="Expired"
            value={summary.expired}
            subtitle="Requires attention"
            icon={<IconAlertTriangle size={16} />}
            iconTone="danger"
            active={expiryFilter === "expired"}
            onClick={() => setExpiryFilter("expired")}
          />
          <StatCard
            title="Zero quantity"
            value={summary.zero}
            subtitle={includeZero ? "Included in this view" : "Currently hidden"}
            icon={<IconPackage size={16} />}
            iconTone="info"
            active={includeZero}
            onClick={() => setIncludeZero((current) => !current)}
          />
        </div>
      )}

      <div className={css.toolbar}>
        <div className={css.searchWrap}>
          <IconSearch size={15} className={css.searchIcon} />
          <input
            type="search"
            className={css.searchInput}
            placeholder="Search batch no, SKU, product…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <InventoryFilterSelect
          label="Expiry status"
          value={expiryFilter}
          options={[
            { value: "all", label: "All expiry" },
            { value: "near", label: "Near expiry (≤30d)" },
            { value: "expired", label: "Expired" },
            { value: "ok", label: "Healthy expiry" },
          ]}
          onChange={(value) => setExpiryFilter(value as ExpiryFilter)}
        />
        <label className={`${css.zeroToggle} ${includeZero ? css.zeroToggleActive : ""}`}>
          <input
            type="checkbox"
            checked={includeZero}
            onChange={(e) => setIncludeZero(e.target.checked)}
          />
          Show zero-qty batches
        </label>
        <button
          type="button"
          className={css.exportButton}
          onClick={exportRows}
          disabled={rows.length === 0}
          data-tooltip={
            rows.length === 0
              ? "Nothing to export for the current filters"
              : "Download filtered batches as CSV"
          }
        >
          <IconDownload size={15} />
          Export
        </button>
      </div>

      {batches.error && <Alert variant="error">{batches.error}</Alert>}

      <BatchesTable
        rows={rows}
        loading={batches.loading}
        page={page}
        canWrite={canWrite}
        onPageChange={setPage}
      />
    </>
  );
}

export default function InventoryBatchesPage() {
  return (
    <Suspense fallback={<div className={css.loading}>Loading batches…</div>}>
      <BatchesContent />
    </Suspense>
  );
}
