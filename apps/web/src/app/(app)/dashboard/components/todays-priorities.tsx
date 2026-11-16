"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DailyWorkItem } from "@pharmaceylon/shared";
import productsCss from "@/app/(app)/products/products.module.css";
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconRefresh,
} from "@/components/icons";
import type { BatchRow, StockRow } from "@/app/(app)/inventory/types";
import type { PurchaseOrderListItem } from "@/app/(app)/purchasing/types";
import { isPoOverdue } from "@/app/(app)/purchasing/utils";
import type { DashboardData } from "../hooks/use-dashboard-data";
import { useDailyWork } from "../hooks/use-daily-work";
import {
  stockItemsForFilter,
  usePriorityStock,
} from "../hooks/use-priority-stock";
import { WORK_PAGE_SIZE } from "../lib/fixed-layout";
import {
  isStockFilter,
  STOCK_PRIORITY_CHIPS,
  WORK_PRIORITY_CHIPS,
  type PriorityChipDef,
  type PriorityFilterKey,
} from "../lib/priority-filters";
import { dashboardHref, usePosHidden } from "../lib/pos-links";
import { paginate } from "../lib/paginate";
import { workAreaTag } from "../lib/work-area-tag";
import { asOfLabel } from "../widgets/counter-waiting";
import { workTiming } from "./daily-work-queue";
import css from "./todays-priorities.module.css";

type Props = {
  data: DashboardData;
  refreshKey: string | null;
  counterLive?: boolean;
  showManagerStockChips?: boolean;
  /** When the dashboard cannot reach the server, hide stale queue rows. */
  forceUnavailable?: boolean;
};

const CHIP_SELECTED_TONE: Record<PriorityFilterKey, string> = {
  all: css.chipToneSlate,
  approvals: css.chipToneSky,
  counter: css.chipToneTeal,
  overdue_deliveries: css.chipToneRose,
  low_stock: css.chipToneAmber,
  near_expiry: css.chipToneOrange,
  controlled: css.chipToneViolet,
  out_of_stock: css.chipToneDanger,
};

function workRowMeta(item: DailyWorkItem, timezone: string, asOf: string): string {
  const timing = workTiming(item, timezone, asOf);
  if (item.overdue) return "⚠ Overdue";
  if (timing.startsWith("Due ") || timing.startsWith("Overdue")) return timing.replace(/^Overdue · /, "");
  return item.detail.replace(/_/g, " ").slice(0, 40);
}

export function TodaysPriorities({
  data,
  refreshKey,
  counterLive = false,
  showManagerStockChips = false,
  forceUnavailable = false,
}: Props) {
  const branchId = data.branchId;
  const [filter, setFilter] = useState<PriorityFilterKey>("all");
  const [clientPage, setClientPage] = useState(1);
  const chipsRef = useRef<HTMLDivElement>(null);
  const [chipsOverflow, setChipsOverflow] = useState(false);
  const posHidden = usePosHidden();

  const workFilter = useMemo(() => {
    if (isStockFilter(filter) || filter === "overdue_deliveries") return "all" as const;
    return (
      WORK_PRIORITY_CHIPS.find((c) => c.key === filter)?.workFilter ?? "all"
    );
  }, [filter]);
  const work = useDailyWork(branchId, refreshKey, workFilter, WORK_PAGE_SIZE);

  const stockLists = usePriorityStock(branchId, refreshKey, true);

  const overduePosAll = useMemo(
    () => data.purchaseOrders.filter(isPoOverdue),
    [data.purchaseOrders],
  );

  const counts = useMemo((): Partial<Record<PriorityFilterKey, number>> => {
    const w = work.data?.counts;
    return {
      all: w?.all,
      approvals: w?.approvals,
      counter: counterLive || work.data?.counterLive ? w?.counter : undefined,
      overdue_deliveries: data.overduePos,
      low_stock:
        data.inventory?.lowStock ?? data.ownerLowStock ?? data.lowStockCount ?? 0,
      near_expiry: data.nearExpiryCount,
      controlled: data.controlledAttentionCount,
      out_of_stock: showManagerStockChips
        ? data.inventory?.outOfStock
        : undefined,
    };
  }, [counterLive, data, showManagerStockChips, work.data]);

  const chips = useMemo(() => {
    const base = [...WORK_PRIORITY_CHIPS];
    if (!counterLive && !work.data?.counterLive) {
      const withoutCounter = base.filter((c) => c.key !== "counter");
      base.length = 0;
      base.push(...withoutCounter);
    }
    base.push(
      ...STOCK_PRIORITY_CHIPS.filter(
        (c) => c.key !== "out_of_stock" || showManagerStockChips,
      ),
    );
    return base.filter((chip) => {
      if (chip.key === "all") return true;
      const n = counts[chip.key] ?? 0;
      return n > 0;
    });
  }, [counts, counterLive, showManagerStockChips, work.data?.counterLive]);

  useEffect(() => {
    const el = chipsRef.current;
    if (!el) return;
    const check = () => setChipsOverflow(el.scrollWidth > el.clientWidth + 2);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [chips]);

  useEffect(() => {
    setClientPage(1);
  }, [filter]);

  const selectFilter = useCallback(
    (key: PriorityFilterKey) => {
      setFilter(key);
      const def = WORK_PRIORITY_CHIPS.find((c) => c.key === key);
      if (def?.workFilter) work.selectFilter(def.workFilter);
    },
    [work],
  );

  const reload = useCallback(() => {
    if (forceUnavailable) {
      void data.reload();
      return;
    }
    if (isStockFilter(filter) || filter === "overdue_deliveries") return;
    work.reload();
  }, [data, filter, forceUnavailable, work]);

  const workRows = work.data?.items ?? [];
  const stockRows = isStockFilter(filter)
    ? stockItemsForFilter(stockLists, filter)
    : [];

  const overdueRows = filter === "overdue_deliveries" ? overduePosAll : [];

  type Row =
    | { kind: "work"; item: DailyWorkItem }
    | { kind: "po"; item: PurchaseOrderListItem }
    | { kind: "stock"; item: StockRow | BatchRow };

  const allClientRows: Row[] = useMemo(() => {
    if (filter === "overdue_deliveries") {
      return overdueRows.map((item) => ({ kind: "po" as const, item }));
    }
    if (isStockFilter(filter)) {
      return stockRows.map((item) => ({ kind: "stock" as const, item }));
    }
    return workRows.map((item) => ({ kind: "work" as const, item }));
  }, [filter, overdueRows, stockRows, workRows]);

  const usingClientPager =
    isStockFilter(filter) || filter === "overdue_deliveries";
  const page = usingClientPager ? clientPage : work.page;
  const total = usingClientPager
    ? allClientRows.length
    : (work.data?.total ?? 0);
  const pageItems = usingClientPager
    ? paginate(allClientRows, page - 1, WORK_PAGE_SIZE)
    : allClientRows.map((r) => r);

  const pageCount = Math.max(1, Math.ceil(total / WORK_PAGE_SIZE));
  const rangeStart = total ? (page - 1) * WORK_PAGE_SIZE + 1 : 0;
  const rangeEnd = Math.min(page * WORK_PAGE_SIZE, total);

  const loading =
    (!usingClientPager && work.loading && !work.data) ||
    (isStockFilter(filter) && stockLists.loading && allClientRows.length === 0);
  const error =
    forceUnavailable ||
    (!usingClientPager ? Boolean(work.error) : Boolean(stockLists.error));

  const subtitle = work.data
    ? `${work.data.branchName} · Relevant work, including carry-over · ${asOfLabel(work.data.asOf, work.data.timezone)}`
    : data.branchName
      ? `${data.branchName} · Relevant work, including carry-over`
      : "Relevant work, including carry-over";

  function renderRow(row: Row) {
    if (row.kind === "work") {
      const item = row.item;
      const href = dashboardHref(item.href, posHidden);
      const urgent = item.overdue || item.priority === 0;
      return (
        <div key={item.id} className={css.row}>
          <span
            className={`${css.typeIcon} ${urgent ? css.typeUrgent : ""}`}
            aria-hidden
          >
            {item.overdue ? (
              <IconAlertTriangle size={16} />
            ) : item.approval ? (
              "!"
            ) : (
              "•"
            )}
          </span>
          <span className={css.title}>{item.title}</span>
          <span className={css.areaTag}>{workAreaTag(item.kind)}</span>
          <span className={item.overdue ? css.metaOverdue : css.meta}>
            {work.data
              ? workRowMeta(item, work.data.timezone, work.data.asOf)
              : item.detail}
          </span>
          {href ? (
            <Link className={css.action} href={href}>
              {item.action}
              <IconChevronRight size={13} />
            </Link>
          ) : (
            <span className={css.action}>{item.action}</span>
          )}
        </div>
      );
    }
    if (row.kind === "po") {
      const po = row.item;
      return (
        <div key={po.id} className={css.row}>
          <span className={`${css.typeIcon} ${css.typeUrgent}`} aria-hidden>
            <IconAlertTriangle size={16} />
          </span>
          <span className={css.title}>{po.poNumber}</span>
          <span className={css.areaTag}>Purchasing</span>
          <span className={css.metaOverdue}>⚠ Overdue</span>
          <Link className={css.action} href={`/purchasing?po=${po.id}`}>
            Review
            <IconChevronRight size={13} />
          </Link>
        </div>
      );
    }
    const stock = row.item;
    if ("productId" in stock && "stockStatus" in stock) {
      const s = stock as StockRow;
      return (
        <div key={s.productId} className={css.row}>
          <span className={css.typeIcon} aria-hidden>
            •
          </span>
          <span className={css.title}>{s.product.name}</span>
          <span className={css.areaTag}>Inventory</span>
          <span className={css.meta}>
            {s.availableQty} {s.product.unit ?? "units"} available
          </span>
          <Link className={css.action} href={`/inventory?product=${s.productId}`}>
            Open
            <IconChevronRight size={13} />
          </Link>
        </div>
      );
    }
    const b = stock as BatchRow;
    return (
      <div key={b.id} className={css.row}>
        <span className={css.typeIcon} aria-hidden>
          •
        </span>
        <span className={css.title}>{b.product.name}</span>
        <span className={css.areaTag}>Expiry</span>
        <span className={css.meta}>
          Batch {b.batchNo} · {b.daysToExpiry}d
        </span>
        <Link className={css.action} href={`/inventory/batches?batch=${b.id}`}>
          Open
          <IconChevronRight size={13} />
        </Link>
      </div>
    );
  }

  return (
    <section className={css.card} aria-labelledby="todays-priorities-title">
      <header className={css.header}>
        <div className={css.headerTitle}>
          <h2 id="todays-priorities-title">Today&apos;s priorities</h2>
          <p>{subtitle}</p>
        </div>
        <button
          type="button"
          className={css.refresh}
          aria-label="Refresh work queue"
          disabled={work.loading && !usingClientPager}
          onClick={reload}
        >
          <IconRefresh size={16} />
        </button>
      </header>

      <div
        className={`${css.chipsWrap} ${chipsOverflow ? css.chipsWrapOverflow : ""}`}
      >
        <div
          ref={chipsRef}
          className={css.chips}
          role="tablist"
          aria-label="Filter today's priorities"
        >
          {chips.map((chip) => {
            const selected = filter === chip.key;
            const count = counts[chip.key];
            return (
              <button
                key={chip.key}
                type="button"
                role="tab"
                aria-selected={selected}
                className={[
                  productsCss.statusPill,
                  chip.toneClass,
                  selected ? CHIP_SELECTED_TONE[chip.key] : "",
                  selected ? productsCss.statusPillActive : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => selectFilter(chip.key)}
              >
                {selected ? <IconCheck size={12} aria-hidden /> : null}
                {chip.label}
                <span className={css.chipCount}>
                  {loading && count == null ? "—" : (count ?? 0)}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className={css.list} aria-busy={loading}>
        {error ? (
          <div className={css.error} role="alert">
            <strong>Work queue unavailable</strong>
            <p>Can&apos;t reach the server.</p>
            <p>
              Tasks may still need attention — open the relevant operation to
              check.
            </p>
            <button type="button" onClick={reload}>
              Try again
            </button>
          </div>
        ) : null}
        {loading && !error ? (
          <div className={css.skeleton} role="status" aria-label="Loading priorities">
            {Array.from({ length: WORK_PAGE_SIZE }).map((_, i) => (
              <div key={i} className={css.skeletonRow} />
            ))}
          </div>
        ) : null}
        {!loading && !error && pageItems.length === 0 ? (
          <div className={css.empty}>
            <IconCheck size={28} />
            <b>
              {filter === "all" ? "You're up to date" : "No work matches this view"}
            </b>
          </div>
        ) : null}
        {!loading && !error
          ? (usingClientPager ? pageItems : workRows).map((row) =>
              usingClientPager
                ? renderRow(row as Row)
                : renderRow({ kind: "work", item: row as DailyWorkItem }),
            )
          : null}
      </div>

      <footer className={css.footer}>
        <span role="status">
          {loading
            ? "Updating…"
            : `${rangeStart}–${rangeEnd} of ${total} tasks`}
        </span>
        <div className={css.pager}>
          <button
            type="button"
            disabled={loading || page <= 1}
            onClick={() =>
              usingClientPager
                ? setClientPage((p) => p - 1)
                : work.setPage(page - 1)
            }
            aria-label="Previous page"
          >
            <IconChevronLeft size={14} />
            Previous
          </button>
          <button
            type="button"
            disabled={loading || page >= pageCount}
            onClick={() =>
              usingClientPager
                ? setClientPage((p) => p + 1)
                : work.setPage(page + 1)
            }
            aria-label="Next page"
          >
            Next
            <IconChevronRight size={14} />
          </button>
        </div>
      </footer>
    </section>
  );
}