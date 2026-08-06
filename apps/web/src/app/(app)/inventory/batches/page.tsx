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
import { apiJson } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";
import { AdjustmentModal } from "../components/adjustment-modal";
import { BatchesTable } from "../components/batches-table";
import { InventoryFilterSelect } from "../components/inventory-filter-select";
import { useInventoryBatches } from "../hooks/use-inventory-batches";
import css from "../inventory.module.css";
import type { BatchRow, ExpiryFilter } from "../types";
import { canAdjustOut, hasInventoryWriteAccess } from "../utils";

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
  const canQuarantineExpired = canAdjustOut(user, branchId);

  const [search, setSearch] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [page, setPage] = useState(1);
  const [expiryFilter, setExpiryFilter] = useState<ExpiryFilter>(() => {
    if (nearExpiryDays != null) return "near";
    if (searchParams.get("expired") === "1") return "expired";
    return "all";
  });
  const [includeZero, setIncludeZero] = useState(false);
  const [quarantineBusy, setQuarantineBusy] = useState(false);
  const [quarantineMsg, setQuarantineMsg] = useState<string | null>(null);
  const [quarantineError, setQuarantineError] = useState(false);
  const [adjustmentOpen, setAdjustmentOpen] = useState(
    searchParams.get("openAdjustment") === "1",
  );
  const [adjustmentContext, setAdjustmentContext] = useState<{
    productId: string;
    batchId: string;
  }>({
    productId: productId ?? "",
    batchId: searchParams.get("batchId") ?? "",
  });
  const [adjustmentSuccess, setAdjustmentSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (searchParams.get("openAdjustment") !== "1") return;
    const next = new URLSearchParams(searchParams.toString());
    next.delete("openAdjustment");
    next.delete("batchId");
    const qs = next.toString();
    router.replace(qs ? `/inventory/batches?${qs}` : "/inventory/batches");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!adjustmentSuccess) return;
    const t = setTimeout(() => setAdjustmentSuccess(null), 6000);
    return () => clearTimeout(t);
  }, [adjustmentSuccess]);

  function openAdjustment(row?: BatchRow) {
    setAdjustmentContext({
      productId: row?.productId ?? productId ?? "",
      batchId: row?.id ?? "",
    });
    setAdjustmentOpen(true);
  }

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [debouncedQ, expiryFilter, includeZero, productId, nearExpiryDays]);

  // Keep the URL in sync when filters change so deep-links (e.g. from dashboard) stay accurate.
  useEffect(() => {
    const next = new URLSearchParams(searchParams.toString());
    if (expiryFilter === "near") {
      next.set("nearExpiryDays", String(nearExpiryDays ?? 30));
      next.delete("expired");
    } else if (expiryFilter === "expired") {
      next.set("expired", "1");
      next.delete("nearExpiryDays");
    } else {
      next.delete("nearExpiryDays");
      next.delete("expired");
    }
    const qs = next.toString();
    const target = qs ? `/inventory/batches?${qs}` : "/inventory/batches";
    const current = searchParams.toString()
      ? `/inventory/batches?${searchParams.toString()}`
      : "/inventory/batches";
    if (target !== current) {
      router.replace(target);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiryFilter]);

  const expiredParam = searchParams.get("expired") === "1";

  const batches = useInventoryBatches({
    productId,
    nearExpiryDays: expiryFilter === "near" ? (nearExpiryDays ?? 30) : null,
    expired: expiryFilter === "expired" || expiredParam ? true : null,
    includeZero,
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
      expiredOpen: scopedRows.filter((batch) => batch.expired && !batch.isQuarantined)
        .length,
      healthy: scopedRows.filter((batch) => !batch.expired && !batch.nearExpiry)
        .length,
      zero: includeZero
        ? batches.rows.filter((batch) => batch.qtyOnHand === 0).length
        : null,
    }),
    [scopedRows, batches.rows, includeZero],
  );

  async function quarantineAllExpired() {
    if (!canQuarantineExpired) return;
    if (
      !window.confirm(
        `Quarantine all ${summary.expiredOpen} expired batch(es) that are not already quarantined?`,
      )
    ) {
      return;
    }
    setQuarantineBusy(true);
    setQuarantineMsg(null);
    setQuarantineError(false);
    try {
      const result = await apiJson<{ quarantined: number }>(
        "/inventory/quarantine-expired",
        { method: "POST" },
      );
      setQuarantineMsg(
        result.quarantined === 0
          ? "No expired batches needed quarantine."
          : `Quarantined ${result.quarantined} expired batch${result.quarantined === 1 ? "" : "es"}.`,
      );
      await batches.reload();
    } catch (err) {
      setQuarantineError(true);
      setQuarantineMsg(err instanceof Error ? err.message : "Quarantine failed");
    } finally {
      setQuarantineBusy(false);
    }
  }

  const exportRows = () => {
    const escapeCsv = (value: string | number) => {
      const text = String(value);
      return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    };
    const csv = [
      [
        "Product",
        "SKU",
        "Batch",
        "Expiry",
        "On hand",
        "Cost",
        "Selling price",
        "Quarantined",
        "Quarantine reason",
      ],
      ...rows.map((batch) => [
        batch.product.name,
        batch.product.sku,
        batch.batchNo,
        batch.expiryDate,
        batch.qtyOnHand,
        batch.costPrice,
        batch.sellingPrice,
        batch.isQuarantined ? "yes" : "no",
        batch.quarantineReason ?? "",
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
        description="Batch-level stock ordered by expiry (FEFO). Quarantine expired or unsafe lots."
        actions={
          <>
            {canQuarantineExpired && summary.expiredOpen > 0 ? (
              <ActionButton
                icon={<IconAlertTriangle size={16} />}
                tooltip="Mark all expired non-quarantined batches as quarantined"
                onClick={() => void quarantineAllExpired()}
                disabled={quarantineBusy}
              >
                Quarantine expired
              </ActionButton>
            ) : null}
            {canWrite ? (
              <ActionButton
                icon={<IconPlus size={16} />}
                tooltip="Post a stock quantity correction"
                onClick={() => openAdjustment()}
              >
                New adjustment
              </ActionButton>
            ) : null}
          </>
        }
      />

      {adjustmentSuccess && <Alert variant="success">{adjustmentSuccess}</Alert>}

      {!batches.hasBranch && (
        <div className={css.branchNotice}>
          Select a branch in the header to view batch stock for that location.
        </div>
      )}

      {quarantineMsg && (
        <Alert variant={quarantineError ? "error" : "info"}>{quarantineMsg}</Alert>
      )}

      {batches.hasBranch && (
        <div className={css.batchKpiRow}>
          <StatCard size="sm"
            title="Active batches"
            value={summary.total}
            subtitle={`${summary.units} units on hand`}
            icon={<IconPackage size={16} />}
            iconTone="primary"
            active={expiryFilter === "all"}
            onClick={() => setExpiryFilter("all")}
          />
          <StatCard size="sm"
            title="Healthy expiry"
            value={summary.healthy}
            subtitle="Outside 30 days"
            icon={<IconCheck size={16} />}
            iconTone="success"
            active={expiryFilter === "ok"}
            onClick={() => setExpiryFilter("ok")}
          />
          <StatCard size="sm"
            title="Expiring soon"
            value={summary.near}
            subtitle="Within 30 days"
            icon={<IconCalendar size={16} />}
            iconTone="warning"
            active={expiryFilter === "near"}
            onClick={() => setExpiryFilter("near")}
          />
          <StatCard size="sm"
            title="Expired"
            value={summary.expired}
            subtitle={
              summary.expiredOpen > 0
                ? `${summary.expiredOpen} not quarantined`
                : "Requires attention"
            }
            icon={<IconAlertTriangle size={16} />}
            iconTone="danger"
            active={expiryFilter === "expired"}
            onClick={() => setExpiryFilter("expired")}
          />
          <StatCard size="sm"
            title="Zero quantity"
            value={summary.zero ?? "—"}
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
        onChanged={() => void batches.reload()}
        onAdjust={openAdjustment}
      />

      <AdjustmentModal
        open={adjustmentOpen}
        onClose={() => setAdjustmentOpen(false)}
        initialProductId={adjustmentContext.productId}
        initialBatchId={adjustmentContext.batchId}
        onSuccess={(message) => {
          setAdjustmentSuccess(message);
          void batches.reload();
        }}
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
