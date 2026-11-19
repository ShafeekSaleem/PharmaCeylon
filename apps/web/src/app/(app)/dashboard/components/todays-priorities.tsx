"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DailyWorkItem } from "@pharmaceylon/shared";
import {
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
} from "@/components/icons";
import type { BatchRow, StockRow } from "@/app/(app)/inventory/types";
import type { PurchaseOrderListItem } from "@/app/(app)/purchasing/types";
import { isPoOverdue } from "@/app/(app)/purchasing/utils";
import type { DashboardData } from "../hooks/use-dashboard-data";
import { useDailyWork } from "../hooks/use-daily-work";
import {
  stockItemsForFilter,
  stockListForChipCount,
  usePriorityStock,
} from "../hooks/use-priority-stock";
import {
  chipCountForDisplay,
  formatPriorityListTotal,
  priorityListCount,
  PRIORITY_LIST_TAKE,
  type PriorityListCount,
} from "../lib/priority-list-count";
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
import { groupWorkItems, workLateness, type WorkLateness } from "../lib/work-groups";
import { asOfLabel } from "../widgets/counter-waiting";
import css from "./todays-priorities.module.css";

type Props = {
  data: DashboardData;
  refreshKey: string | null;
  counterLive?: boolean;
  showManagerStockChips?: boolean;
  /** When the dashboard cannot reach the server, hide stale queue rows. */
  forceUnavailable?: boolean;
};

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

  const stockListsEnabled =
    Boolean(branchId) && filter !== "overdue_deliveries";
  const stockLists = usePriorityStock(
    branchId,
    refreshKey,
    stockListsEnabled,
  );

  const overduePosAll = useMemo(
    () => data.purchaseOrders.filter(isPoOverdue),
    [data.purchaseOrders],
  );
  const purchaseOrdersFailed = data.failedSections.has("Purchase orders");

  const stockListsReady =
    stockListsEnabled && !stockLists.loading && !stockLists.error;

  const counts = useMemo((): Partial<Record<PriorityFilterKey, PriorityListCount>> => {
    const w = work.data?.counts;
    const stockCount = (key: PriorityFilterKey): PriorityListCount | undefined => {
      if (!stockListsEnabled) return undefined;
      if (stockLists.loading && !stockListsReady) return undefined;
      if (stockLists.error) return 0;
      return priorityListCount(stockListForChipCount(stockLists, key).length);
    };
    return {
      all: w?.all,
      approvals: w?.approvals,
      counter: counterLive || work.data?.counterLive ? w?.counter : undefined,
      overdue_deliveries: purchaseOrdersFailed
        ? 0
        : priorityListCount(overduePosAll.length),
      low_stock: stockCount("low_stock"),
      near_expiry: stockCount("near_expiry"),
      controlled: stockCount("controlled"),
      out_of_stock: showManagerStockChips
        ? stockCount("out_of_stock")
        : undefined,
    };
  }, [
    counterLive,
    overduePosAll.length,
    purchaseOrdersFailed,
    showManagerStockChips,
    stockLists,
    stockListsEnabled,
    stockListsReady,
    work.data,
  ]);

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
      const n = counts[chip.key];
      if (n === "200+") return true;
      return (n ?? 0) > 0;
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

  useEffect(() => {
    if (filter === "all") return;
    if (isStockFilter(filter) && stockLists.error) return;
    if (filter === "overdue_deliveries" && purchaseOrdersFailed) return;
    const n = counts[filter];
    if (n === undefined) return;
    if (n === 0) {
      setFilter("all");
      work.selectFilter("all");
    }
  }, [counts, filter, purchaseOrdersFailed, stockLists.error, work]);

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
    if (filter === "overdue_deliveries") {
      void data.reload();
      return;
    }
    if (isStockFilter(filter)) return;
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
  const clientListCapped =
    usingClientPager &&
    (isStockFilter(filter)
      ? stockItemsForFilter(stockLists, filter).length >= PRIORITY_LIST_TAKE
      : overduePosAll.length >= PRIORITY_LIST_TAKE);
  const page = usingClientPager ? clientPage : work.page;
  const clientTotal = allClientRows.length;
  const total = usingClientPager ? clientTotal : (work.data?.total ?? 0);
  const pageItems = usingClientPager
    ? paginate(allClientRows, page - 1, WORK_PAGE_SIZE)
    : allClientRows.map((r) => r);

  const pageCount = Math.max(1, Math.ceil(total / WORK_PAGE_SIZE));
  const rangeStart = total ? (page - 1) * WORK_PAGE_SIZE + 1 : 0;
  const rangeEnd = Math.min(page * WORK_PAGE_SIZE, total);

  const rowNoun =
    filter === "overdue_deliveries"
      ? "orders"
      : isStockFilter(filter)
        ? "items"
        : "tasks";

  const loading =
    (!usingClientPager && work.loading && !work.data) ||
    (filter === "overdue_deliveries" && data.loading && overdueRows.length === 0) ||
    (isStockFilter(filter) &&
      stockLists.loading &&
      allClientRows.length === 0);
  const error = forceUnavailable
    ? true
    : filter === "overdue_deliveries"
      ? purchaseOrdersFailed
      : isStockFilter(filter)
        ? Boolean(stockLists.error)
        : Boolean(work.error);

  const errorCopy = useMemo(() => {
    if (forceUnavailable) {
      return {
        title: "Work queue unavailable",
        body: "Can't reach the server.",
        hint: "Items may still need attention — open the relevant operation to check.",
      };
    }
    if (filter === "overdue_deliveries" && purchaseOrdersFailed) {
      return {
        title: "Purchase orders unavailable",
        body: "Couldn't load purchase orders.",
        hint: "Overdue deliveries may still need attention — open Purchasing to check.",
      };
    }
    if (isStockFilter(filter) && stockLists.error) {
      return {
        title: "Stock lists unavailable",
        body: stockLists.error,
        hint: "Stock may still need attention — open Inventory to check.",
      };
    }
    return {
      title: "Work queue unavailable",
      body: work.error ?? "Can't reach the server.",
      hint: "Tasks may still need attention — open the relevant operation to check.",
    };
  }, [filter, forceUnavailable, purchaseOrdersFailed, stockLists.error, work.error]);

  const subtitle = work.data
    ? `${work.data.counts.all} open · ${work.data.counts.overdue} late · as of ${asOfLabel(work.data.asOf, work.data.timezone).replace(/^As of /, "")}`
    : (data.branchName ?? "");

  function rowView(opts: {
    key: string;
    title: string;
    reference?: string;
    detail?: string;
    lateness?: WorkLateness;
    href?: string | null;
    action: string;
  }) {
    return (
      <div key={opts.key} className={css.row}>
        <div className={css.rowMain}>
          <div className={css.title}>
            {opts.title}
            {opts.reference ? (
              <span className={css.reference}>{opts.reference}</span>
            ) : null}
          </div>
          {opts.detail ? <div className={css.detail}>{opts.detail}</div> : null}
        </div>
        {opts.lateness ? (
          <span
            className={
              opts.lateness.tone === "late"
                ? css.late
                : opts.lateness.tone === "soon"
                  ? css.soon
                  : css.timing
            }
          >
            {opts.lateness.text}
          </span>
        ) : null}
        {opts.href ? (
          <Link className={css.action} href={opts.href}>
            {opts.action}
          </Link>
        ) : (
          <span className={css.action}>{opts.action}</span>
        )}
      </div>
    );
  }

  function renderWork(item: DailyWorkItem) {
    return rowView({
      key: item.id,
      title: item.title,
      reference: item.reference,
      detail: item.detail,
      lateness: work.data
        ? workLateness(item, work.data.timezone, work.data.asOf)
        : undefined,
      href: dashboardHref(item.href, posHidden),
      action: item.action,
    });
  }

  function renderRow(row: Row) {
    if (row.kind === "work") return renderWork(row.item);
    if (row.kind === "po") {
      const po = row.item;
      return rowView({
        key: po.id,
        title: "Delivery overdue",
        reference: po.poNumber,
        detail: po.supplier?.name,
        lateness: { text: "Overdue", tone: "late" },
        href: `/purchasing?po=${po.id}`,
        action: "Review order",
      });
    }
    const stock = row.item;
    if ("productId" in stock && "stockStatus" in stock) {
      const s = stock as StockRow;
      return rowView({
        key: s.productId,
        title: s.product.name,
        detail: `${s.availableQty} ${s.product.unit ?? "units"} available`,
        href: `/inventory?product=${s.productId}`,
        action: "Open",
      });
    }
    const b = stock as BatchRow;
    return rowView({
      key: b.id,
      title: b.product.name,
      reference: `Batch ${b.batchNo}`,
      detail: `Expires in ${b.daysToExpiry} day${b.daysToExpiry === 1 ? "" : "s"}`,
      href: `/inventory/batches?batch=${b.id}`,
      action: "Open",
    });
  }

  return (
    <section className={css.card} aria-labelledby="todays-priorities-title">
      <header className={css.header}>
        <h2 id="todays-priorities-title">To do at this branch</h2>
        <p>{subtitle}</p>
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
                className={`${css.tab} ${selected ? css.tabActive : ""}`}
                onClick={() => selectFilter(chip.key)}
              >
                {chip.label}
                <span className={css.chipCount}>
                  {chipCountForDisplay(
                    count,
                    Boolean(
                      isStockFilter(chip.key) &&
                        stockLists.loading &&
                        count == null,
                    ),
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className={css.list} aria-busy={loading}>
        {error ? (
          <div className={css.error} role="alert">
            <strong>{errorCopy.title}</strong>
            <p>{errorCopy.body}</p>
            <p>{errorCopy.hint}</p>
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
          ? usingClientPager
            ? pageItems.map((row) => renderRow(row as Row))
            : groupWorkItems(workRows).map((group) => (
                <div key={group.key} className={css.group}>
                  <h3 className={css.groupTitle}>{group.title}</h3>
                  {group.items.map(renderWork)}
                </div>
              ))
          : null}
      </div>

      <footer className={css.footer}>
        <span role="status">
          {loading
            ? "Updating…"
            : usingClientPager
              ? `${rangeStart}–${rangeEnd} of ${formatPriorityListTotal(total, clientListCapped)} ${rowNoun}`
              : `${rangeStart}–${rangeEnd} of ${total} ${rowNoun}`}
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