"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/alert";
import {
  IconAlertTriangle,
  IconCalendar,
  IconCheck,
  IconDownload,
  IconLock,
  IconPackage,
  IconPlus,
  IconSearch,
} from "@/components/icons";
import { ProductContextBanner } from "@/components/product-context-banner";
import { ActionButton, ActiveFilterBanner, PageHeader, StatCard } from "@/components/ui";
import type { FilterPill } from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import { ConfirmDialog } from "../../products/components/confirm-dialog";
import { AdjustmentModal } from "../components/adjustment-modal";
import { BatchesTable } from "../components/batches-table";
import { InventoryFilterSelect } from "../components/inventory-filter-select";
import { InventorySubnav } from "../components/inventory-subnav";
import { ProductStockSheet } from "../components/product-stock-sheet";
import { useInventoryAccess } from "../hooks/use-inventory-access";
import { useInventoryBatches } from "../hooks/use-inventory-batches";
import css from "../inventory.module.css";
import type { BatchRow, ExpiryFilter } from "../types";
import { formatUnits } from "../utils";

type HoldFilter = "all" | "quarantined";

function BatchesContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const productId = searchParams.get("productId");
  const controlledParam = searchParams.get("controlled");
  const controlled =
    controlledParam === "controlled" || controlledParam === "regular" ? controlledParam : null;
  const nearExpiryParam = searchParams.get("nearExpiryDays");
  const nearExpiryDays = (() => {
    if (!nearExpiryParam) return null;
    const n = Number(nearExpiryParam);
    return Number.isFinite(n) && n > 0 ? n : null;
  })();
  const access = useInventoryAccess();
  const canAdjust = access.canAdjustIn || access.canWriteOff;

  const [search, setSearch] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [page, setPage] = useState(1);
  const [expiryFilter, setExpiryFilter] = useState<ExpiryFilter>(() => {
    if (nearExpiryDays != null) return "near";
    if (searchParams.get("expired") === "1") return "expired";
    return "all";
  });
  const [holdFilter, setHoldFilter] = useState<HoldFilter>(
    searchParams.get("quarantined") === "1" ? "quarantined" : "all",
  );
  const [includeZero, setIncludeZero] = useState(false);
  const [quarantineBusy, setQuarantineBusy] = useState(false);
  const [quarantineConfirmOpen, setQuarantineConfirmOpen] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [adjustmentOpen, setAdjustmentOpen] = useState(searchParams.get("openAdjustment") === "1");
  const [adjustmentContext, setAdjustmentContext] = useState<{ productId: string; batchId: string }>({
    productId: productId ?? "",
    batchId: searchParams.get("batchId") ?? "",
  });
  const [sheetProductId, setSheetProductId] = useState<string | null>(null);

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
    if (!notice || notice.tone === "error") return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  function clearFilters() {
    setSearch("");
    setDebouncedQ("");
    setExpiryFilter("all");
    setHoldFilter("all");
    setIncludeZero(false);
    setPage(1);
    const next = new URLSearchParams(searchParams.toString());
    for (const key of [
      "productId",
      "expiry",
      "quarantined",
      "needsExpiryReview",
      "controlled",
      "nearExpiryDays",
    ]) {
      next.delete(key);
    }
    const qs = next.toString();
    router.replace(qs ? `/inventory/batches?${qs}` : "/inventory/batches");
  }

  function openAdjustment(row?: { productId: string; id?: string }) {
    setAdjustmentContext({ productId: row?.productId ?? productId ?? "", batchId: row?.id ?? "" });
    setAdjustmentOpen(true);
  }

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [debouncedQ, expiryFilter, holdFilter, includeZero, productId, nearExpiryDays]);

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
    if (holdFilter === "quarantined") next.set("quarantined", "1");
    else next.delete("quarantined");
    const qs = next.toString();
    const target = qs ? `/inventory/batches?${qs}` : "/inventory/batches";
    const current = searchParams.toString()
      ? `/inventory/batches?${searchParams.toString()}`
      : "/inventory/batches";
    if (target !== current) router.replace(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiryFilter, holdFilter]);

  // Deep-linked from the product importer's "review them now".
  const needsExpiryReview = searchParams.get("needsExpiryReview") === "true";

  const batches = useInventoryBatches({
    productId,
    needsExpiryReview: needsExpiryReview ? true : null,
    quarantined: holdFilter === "quarantined" ? true : null,
    includeZero,
    controlled,
    q: debouncedQ,
  });

  const scopedRows = useMemo(
    () => (includeZero ? batches.rows : batches.rows.filter((batch) => batch.qtyOnHand > 0)),
    [batches.rows, includeZero],
  );

  const rows = useMemo(() => {
    // The placeholder date makes these look "healthy" to every expiry bucket, so the filters
    // below would quietly drop them from their own view.
    if (needsExpiryReview) return scopedRows;
    if (expiryFilter === "near") return scopedRows.filter((b) => b.nearExpiry && !b.expired);
    if (expiryFilter === "expired") return scopedRows.filter((b) => b.expired);
    if (expiryFilter === "ok") return scopedRows.filter((b) => !b.expired && !b.nearExpiry);
    return scopedRows;
  }, [scopedRows, expiryFilter, needsExpiryReview]);

  // What the list is narrowed to right now, named the way every other list page names it.
  const filteredProductName = productId
    ? (batches.rows.find((row) => row.productId === productId)?.product.name ?? "Selected")
    : null;
  const filtersActive = Boolean(
    productId ||
      controlled ||
      needsExpiryReview ||
      nearExpiryDays ||
      debouncedQ ||
      includeZero ||
      expiryFilter !== "all" ||
      holdFilter !== "all",
  );
  const filterPills: FilterPill[] = [
    ...(filteredProductName ? [{ key: "product", label: `Product: ${filteredProductName}` }] : []),
    ...(debouncedQ ? [{ key: "q", label: `Search: ${debouncedQ}` }] : []),
    ...(expiryFilter !== "all"
      ? [
          {
            key: "expiry",
            label:
              expiryFilter === "near"
                ? "Expiring soon"
                : expiryFilter === "expired"
                  ? "Expired"
                  : "Healthy expiry",
          },
        ]
      : []),
    ...(holdFilter !== "all" ? [{ key: "hold", label: "Quarantined" }] : []),
    ...(needsExpiryReview ? [{ key: "review", label: "Expiry needs confirming" }] : []),
    ...(controlled
      ? [{ key: "controlled", label: controlled === "controlled" ? "Controlled" : "Regular" }]
      : []),
    ...(nearExpiryDays ? [{ key: "window", label: `Within ${nearExpiryDays} days` }] : []),
    ...(includeZero ? [{ key: "empty", label: "Including empty batches" }] : []),
  ];

  const holdable = (b: BatchRow) => Math.max(0, b.qtyOnHand - b.quarantinedQty - b.reservedQty);
  const summary = useMemo(
    () => ({
      total: scopedRows.length,
      units: scopedRows.reduce((sum, batch) => sum + batch.qtyOnHand, 0),
      near: scopedRows.filter((batch) => batch.nearExpiry && !batch.expired).length,
      expired: scopedRows.filter((batch) => batch.expired).length,
      expiredOpen: scopedRows.filter((batch) => batch.expired && holdable(batch) > 0).length,
      healthy: scopedRows.filter((batch) => !batch.expired && !batch.nearExpiry).length,
      quarantinedBatches: scopedRows.filter((batch) => batch.quarantinedQty > 0).length,
      quarantinedUnits: scopedRows.reduce((sum, batch) => sum + batch.quarantinedQty, 0),
    }),
    [scopedRows],
  );

  async function quarantineAllExpired() {
    setQuarantineBusy(true);
    try {
      const result = await apiJson<{ quarantined: number; units: number }>(
        "/inventory/quarantine-expired",
        { method: "POST" },
      );
      setNotice({
        tone: "success",
        text:
          result.quarantined === 0
            ? "No expired stock needed quarantining."
            : `Quarantined ${formatUnits(result.units)} across ${result.quarantined} expired batch${
                result.quarantined === 1 ? "" : "es"
              }.`,
      });
      await batches.reload();
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Quarantine failed" });
    } finally {
      setQuarantineBusy(false);
      setQuarantineConfirmOpen(false);
    }
  }

  const exportRows = () => {
    const escapeCsv = (value: string | number) => {
      const text = String(value);
      return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    };
    const header = [
      "Product",
      "SKU",
      "Batch",
      "Expiry",
      "On hand",
      "Available",
      "Quarantined",
      "Reserved",
      ...(access.canViewCost ? ["Cost"] : []),
      "Selling price",
      "Quarantine reason",
    ];
    const csv = [
      header,
      ...rows.map((batch) => [
        batch.product.name,
        batch.product.sku,
        batch.batchNo,
        batch.expiryDate.slice(0, 10),
        batch.qtyOnHand,
        batch.availableQty,
        batch.quarantinedQty,
        batch.reservedQty,
        ...(access.canViewCost ? [batch.costPrice ?? ""] : []),
        batch.sellingPrice,
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
        description={
          controlled === "controlled"
            ? "Batch-level stock ordered by expiry (FEFO). Showing controlled substances only."
            : "Batch-level stock ordered by expiry (FEFO). Quarantine damaged, recalled or expired units."
        }
        actions={
          <>
            {access.canQuarantineAllExpired && summary.expiredOpen > 0 ? (
              <ActionButton
                icon={<IconAlertTriangle size={16} />}
                tooltip="Hold every expired unit that is still sellable"
                onClick={() => setQuarantineConfirmOpen(true)}
                disabled={quarantineBusy}
              >
                Quarantine expired
              </ActionButton>
            ) : null}
            {canAdjust ? (
              <ActionButton
                icon={<IconPlus size={16} />}
                tooltip="Add stock or write stock off on a batch"
                onClick={() => openAdjustment()}
              >
                New adjustment
              </ActionButton>
            ) : null}
          </>
        }
      />

      <InventorySubnav />

      {needsExpiryReview && (
        <Alert variant="info">
          Showing <strong>{rows.length}</strong> batch{rows.length === 1 ? "" : "es"} imported without an
          expiry date. They cannot be sold until reviewed. Use <em>Confirm expiry date</em> in each row&apos;s
          menu to enter the date printed on the pack. <Link href="/inventory/batches">Show all batches</Link>
        </Alert>
      )}
      {notice && <Alert variant={notice.tone}>{notice.text}</Alert>}

      {!batches.hasBranch && (
        <div className={css.branchNotice}>
          Select a branch in the header to view batch stock for that location.
        </div>
      )}

      {batches.hasBranch && (
        <div className={css.batchKpiRow}>
          <StatCard
            size="sm"
            title="Batches with stock"
            value={summary.total}
            subtitle={`${formatUnits(summary.units)} on hand`}
            icon={<IconPackage size={16} />}
            iconTone="primary"
            active={expiryFilter === "all" && holdFilter === "all"}
            onClick={() => {
              setExpiryFilter("all");
              setHoldFilter("all");
            }}
          />
          <StatCard
            size="sm"
            title="Healthy expiry"
            value={summary.healthy}
            subtitle="Outside the warning window"
            icon={<IconCheck size={16} />}
            iconTone="success"
            active={expiryFilter === "ok"}
            onClick={() => setExpiryFilter("ok")}
          />
          <StatCard
            size="sm"
            title="Expiring soon"
            value={summary.near}
            subtitle="Inside the warning window"
            icon={<IconCalendar size={16} />}
            iconTone="warning"
            active={expiryFilter === "near"}
            onClick={() => setExpiryFilter("near")}
          />
          <StatCard
            size="sm"
            title="Expired"
            value={summary.expired}
            subtitle={summary.expiredOpen > 0 ? `${summary.expiredOpen} still sellable` : "All held"}
            icon={<IconAlertTriangle size={16} />}
            iconTone="danger"
            active={expiryFilter === "expired"}
            onClick={() => setExpiryFilter("expired")}
          />
          <StatCard
            size="sm"
            title="Quarantined"
            value={summary.quarantinedBatches}
            subtitle={`${formatUnits(summary.quarantinedUnits)} held`}
            icon={<IconLock size={16} />}
            iconTone="info"
            active={holdFilter === "quarantined"}
            onClick={() => setHoldFilter((current) => (current === "quarantined" ? "all" : "quarantined"))}
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
            aria-label="Search batches"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <InventoryFilterSelect
          label="Expiry status"
          value={expiryFilter}
          options={[
            { value: "all", label: "All expiry" },
            { value: "near", label: "Expiring soon" },
            { value: "expired", label: "Expired" },
            { value: "ok", label: "Healthy expiry" },
          ]}
          onChange={(value) => setExpiryFilter(value as ExpiryFilter)}
        />
        <InventoryFilterSelect
          label="Holding"
          value={holdFilter}
          options={[
            { value: "all", label: "All batches" },
            { value: "quarantined", label: "Has quarantined units" },
          ]}
          onChange={(value) => setHoldFilter(value as HoldFilter)}
        />
        <label className={`${css.zeroToggle} ${includeZero ? css.zeroToggleActive : ""}`}>
          <input type="checkbox" checked={includeZero} onChange={(e) => setIncludeZero(e.target.checked)} />
          Show empty batches
        </label>
        <button
          type="button"
          className={css.exportButton}
          onClick={exportRows}
          disabled={rows.length === 0}
          data-tooltip={rows.length === 0 ? "Nothing to export for the current filters" : "Download filtered batches as CSV"}
        >
          <IconDownload size={15} />
          Export
        </button>
      </div>

      {batches.error && (
        <Alert variant="error">
          {batches.error}{" "}
          <button type="button" className={css.rowTitleButton} onClick={() => void batches.reload()}>
            Try again
          </button>
        </Alert>
      )}

      <ActiveFilterBanner
        active={filtersActive}
        summary={`Filtered batches · ${rows.length} result${rows.length === 1 ? "" : "s"}`}
        pills={filterPills}
        onClear={clearFilters}
        clearTooltip="Show every batch at this branch"
      />

      <BatchesTable
        rows={rows}
        loading={batches.loading}
        page={page}
        access={access}
        onPageChange={setPage}
        onChanged={(message) => {
          if (message) setNotice({ tone: "success", text: message });
          void batches.reload();
        }}
        onAdjust={openAdjustment}
        onOpenProduct={setSheetProductId}
      />

      <ConfirmDialog
        open={quarantineConfirmOpen}
        title="Quarantine expired stock"
        confirmLabel="Quarantine expired"
        loading={quarantineBusy}
        onCancel={() => {
          if (!quarantineBusy) setQuarantineConfirmOpen(false);
        }}
        onConfirm={() => void quarantineAllExpired()}
      >
        <p>
          Hold every sellable unit on <strong>{summary.expiredOpen}</strong> expired batch
          {summary.expiredOpen === 1 ? "" : "es"} at this branch. Units already quarantined, or reserved for a
          transfer, are left as they are.
        </p>
      </ConfirmDialog>

      <ProductStockSheet
        productId={sheetProductId}
        access={access}
        onClose={() => setSheetProductId(null)}
        onAdjust={(pid, batchId) => openAdjustment({ productId: pid, id: batchId })}
        onChanged={(message) => {
          setNotice({ tone: "success", text: message });
          void batches.reload();
        }}
      />

      <AdjustmentModal
        open={adjustmentOpen}
        onClose={() => setAdjustmentOpen(false)}
        initialProductId={adjustmentContext.productId}
        initialBatchId={adjustmentContext.batchId}
        onSuccess={(message) => {
          setNotice({ tone: "success", text: message });
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
