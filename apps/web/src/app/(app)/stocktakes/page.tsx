"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/alert";
import {
  IconCheck,
  IconClipboardList,
  IconEye,
  IconPlus,
  IconSearch,
} from "@/components/icons";
import { ActionButton, DataTable, PageHeader, StatCard, StatusBadge, type Column } from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";
import { InventoryFilterSelect } from "../inventory/components/inventory-filter-select";
import inventoryCss from "../inventory/inventory.module.css";
import layoutCss from "../purchasing/purchasing.module.css";
import { CreateStocktakeModal } from "./components/create-stocktake-modal";
import { StocktakeDetailModal } from "./components/stocktake-detail-modal";
import { STATUS_OPTIONS } from "./constants";
import { useStocktakes } from "./hooks/use-stocktakes";
import scss from "./stocktakes.module.css";
import { PAGE_SIZE, type StocktakeListItem, type StocktakeStatusFilter } from "./types";
import {
  canCompleteStocktake,
  countedProgress,
  formatDate,
  formatSigned,
  formatStocktakeNo,
  hasStocktakeWriteAccess,
  matchesStatusFilter,
  scopeLabel,
} from "./utils";

function StocktakesContent() {
  const { user, branchId } = useAuth();
  const canWrite = hasStocktakeWriteAccess(user, branchId);
  const canManage = canCompleteStocktake(user, branchId);
  const stocktakes = useStocktakes();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StocktakeStatusFilter>("all");
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [detail, setDetail] = useState<StocktakeListItem | null>(null);

  useEffect(() => {
    setPage(1);
  }, [search, statusFilter]);

  const summary = useMemo(() => {
    const counts = {
      draft: 0,
      in_progress: 0,
      completed: 0,
      cancelled: 0,
      openVarianceLines: 0,
    };
    for (const row of stocktakes.rows) {
      if (row.status in counts) {
        counts[row.status as "draft" | "in_progress" | "completed" | "cancelled"] += 1;
      }
      if (row.status === "draft" || row.status === "in_progress") {
        counts.openVarianceLines += row.varianceLineCount ?? 0;
      }
    }
    return counts;
  }, [stocktakes.rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return stocktakes.rows.filter((row) => {
      if (!matchesStatusFilter(row, statusFilter)) return false;
      if (!q) return true;
      const hay = [
        formatStocktakeNo(row),
        row.notes ?? "",
        row.counter.fullName,
        scopeLabel(row.scope),
        row.scope ?? "",
        ...row.lines.map((l) => `${l.product.sku} ${l.product.name} ${l.batch.batchNo}`),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [stocktakes.rows, search, statusFilter]);

  const paged = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }, [filtered, page]);

  function openDetail(row: StocktakeListItem) {
    setDetail(row);
  }

  function handleChanged(updated?: StocktakeListItem) {
    void stocktakes.reload().then(() => {
      if (updated) {
        setDetail(updated);
      }
    });
  }

  const columns: Column<StocktakeListItem>[] = useMemo(
    () => [
      {
        key: "number",
        header: "Stocktake no.",
        render: (row) => (
          <button
            type="button"
            className={scss.stocktakeNo}
            onClick={() => openDetail(row)}
          >
            {formatStocktakeNo(row)}
          </button>
        ),
      },
      {
        key: "status",
        header: "Status",
        render: (row) => <StatusBadge status={row.status} />,
      },
      {
        key: "scope",
        header: "Scope",
        render: (row) => (
          <span className={scss.scopeBadge}>{scopeLabel(row.scope)}</span>
        ),
      },
      {
        key: "lines",
        header: "Progress",
        render: (row) => {
          const total = row.lineCount ?? row.lines.length;
          const counted =
            row.countedLineCount ?? row.lines.filter((l) => l.countedQty != null).length;
          const pct = countedProgress(row);
          return (
            <div>
              <span>
                {counted}/{total} · {pct}%
              </span>
              <div className={layoutCss.progressTrack} aria-hidden>
                <div
                  className={`${layoutCss.progressFill}${
                    pct >= 100
                      ? ` ${layoutCss.progressFillDone}`
                      : pct > 0
                        ? ` ${layoutCss.progressFillWarn}`
                        : ""
                  }`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        },
      },
      {
        key: "variance",
        header: "Variance",
        render: (row) => {
          const lines = row.varianceLineCount ?? 0;
          const net = row.varianceUnitsNet ?? 0;
          return (
            <div className={scss.listVariance}>
              <span>
                {lines} line{lines === 1 ? "" : "s"}
              </span>
              <span className={scss.listVarianceMeta}>
                Net {formatSigned(net)} units
              </span>
            </div>
          );
        },
      },
      {
        key: "created",
        header: "Created",
        render: (row) => formatDate(row.createdAt),
      },
      {
        key: "counter",
        header: "Counter",
        render: (row) => <span className={layoutCss.muted}>{row.counter.fullName}</span>,
      },
      {
        key: "actions",
        header: "Actions",
        render: (row) => (
          <div className={layoutCss.actionsCell}>
            <button
              type="button"
              className={`${layoutCss.actionIcon} ${layoutCss.actionIconView}`}
              onClick={() => openDetail(row)}
              aria-label={`View ${formatStocktakeNo(row)}`}
              data-tooltip="View stocktake"
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
      <PageHeader
        subtitleOnly
        floatingActions
        description="Physical inventory counts with variance posting to stock ledger."
        actions={
          canWrite ? (
            <ActionButton
              icon={<IconPlus size={16} />}
              tooltip="Start a new stocktake for this branch"
              onClick={() => setCreateOpen(true)}
            >
              New stocktake
            </ActionButton>
          ) : null
        }
      />

      {!stocktakes.hasBranch && (
        <div className={inventoryCss.branchNotice}>
          Select a branch in the header to view stocktakes for that location.
        </div>
      )}

      {stocktakes.hasBranch && (
        <div className={inventoryCss.batchKpiRow}>
          <StatCard
            title="Draft"
            value={summary.draft}
            subtitle="Not started"
            icon={<IconClipboardList size={16} />}
            iconTone="primary"
            active={statusFilter === "draft"}
            onClick={() =>
              setStatusFilter((cur) => (cur === "draft" ? "all" : "draft"))
            }
          />
          <StatCard
            title="In progress"
            value={summary.in_progress}
            subtitle="Counting underway"
            icon={<IconClipboardList size={16} />}
            iconTone="info"
            active={statusFilter === "in_progress"}
            onClick={() =>
              setStatusFilter((cur) => (cur === "in_progress" ? "all" : "in_progress"))
            }
          />
          <StatCard
            title="Open variances"
            value={summary.openVarianceLines}
            subtitle="Lines with variance (open)"
            icon={<IconClipboardList size={16} />}
            iconTone="warning"
            active={statusFilter === "draft" || statusFilter === "in_progress"}
            onClick={() =>
              setStatusFilter((cur) =>
                cur === "in_progress" || cur === "draft" ? "all" : "in_progress",
              )
            }
          />
          <StatCard
            title="Completed"
            value={summary.completed}
            subtitle="Variances posted"
            icon={<IconCheck size={16} />}
            iconTone="success"
            active={statusFilter === "completed"}
            onClick={() =>
              setStatusFilter((cur) => (cur === "completed" ? "all" : "completed"))
            }
          />
          <StatCard
            title="Cancelled"
            value={summary.cancelled}
            subtitle="Abandoned counts"
            icon={<IconClipboardList size={16} />}
            iconTone="danger"
            active={statusFilter === "cancelled"}
            onClick={() =>
              setStatusFilter((cur) => (cur === "cancelled" ? "all" : "cancelled"))
            }
          />
        </div>
      )}

      <div className={inventoryCss.toolbar}>
        <div className={inventoryCss.searchWrap}>
          <IconSearch size={15} className={inventoryCss.searchIcon} />
          <input
            type="search"
            className={inventoryCss.searchInput}
            placeholder="Search stocktake no, notes, product…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <InventoryFilterSelect
          label="Status"
          value={statusFilter}
          options={[...STATUS_OPTIONS]}
          onChange={(value) => setStatusFilter(value as StocktakeStatusFilter)}
        />
      </div>

      {stocktakes.error && <Alert variant="error">{stocktakes.error}</Alert>}

      <DataTable<StocktakeListItem>
        columns={columns}
        data={paged}
        rowKey={(r) => r.id}
        loading={stocktakes.loading}
        page={page}
        pageSize={PAGE_SIZE}
        total={filtered.length}
        onPageChange={setPage}
        emptyTitle="No stocktakes yet"
        emptyDescription="Create a draft stocktake and count on-hand batches"
        emptyIcon={<IconClipboardList size={48} />}
        compact
      />

      <CreateStocktakeModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => {
          void (async () => {
            await stocktakes.reload();
            try {
              const row = await apiJson<StocktakeListItem>(`/stocktakes/${id}`);
              setDetail(row);
            } catch {
              /* list reload is enough */
            }
          })();
        }}
      />

      <StocktakeDetailModal
        stocktake={detail}
        canWrite={canWrite}
        canManage={canManage}
        onClose={() => setDetail(null)}
        onChanged={handleChanged}
      />
    </div>
  );
}

export default function StocktakesPage() {
  return (
    <Suspense fallback={<div className={inventoryCss.loading}>Loading stocktakes…</div>}>
      <StocktakesContent />
    </Suspense>
  );
}
