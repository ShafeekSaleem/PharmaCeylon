"use client";

import { useState } from "react";
import Link from "next/link";
import { IconShoppingCart } from "@/components/icons";
import { StatusBadge } from "@/components/ui";
import { formatExpiry, formatMoney } from "@/app/(app)/inventory/utils";
import { DashboardPanel } from "../components/dashboard-panel";
import { PaginationControls } from "../components/pagination-controls";
import type { DashboardData } from "../hooks/use-dashboard-data";
import { paginate } from "../lib/paginate";
import css from "../dashboard.module.css";

const PO_PAGE_SIZE = 4;

export function InventoryClerkPendingPosWidget({ data }: { data: DashboardData }) {
  const { openPoListFull, openPos, openPoValue } = data;
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(openPoListFull.length / PO_PAGE_SIZE));

  return (
    <DashboardPanel
      title="Pending POs"
      footerHref="/purchasing"
      footerLabel="Open purchasing →"
      footerMeta={openPos > 0 ? formatMoney(openPoValue) : undefined}
    >
      {openPoListFull.length === 0 ? (
        <p className={css.emptyState}>No open purchase orders.</p>
      ) : (
        <>
          <ul className={css.pipelineList}>
            {paginate(openPoListFull, page, PO_PAGE_SIZE).map((po) => {
              const lineValue = po.items.reduce(
                (sum, item) => sum + Number(item.unitCost) * item.orderedQty,
                0,
              );
              return (
                <li key={po.id}>
                  <Link href={`/purchasing?po=${po.id}`}>
                    <span className={`${css.pipelineIcon} ${css.pipelineIcon_po}`} aria-hidden>
                      <IconShoppingCart size={14} strokeWidth={1.75} />
                    </span>
                    <span className={css.pipelineRowBody}>
                      <strong>{po.poNumber}</strong>
                      <span className={css.muted}>
                        {po.supplier.name}
                        {po.expectedOn ? ` · due ${formatExpiry(po.expectedOn)}` : ""}
                      </span>
                    </span>
                    <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "0.2rem" }}>
                      <StatusBadge status={po.status} />
                      <span className={css.muted}>{formatMoney(lineValue)}</span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
          <PaginationControls
            page={page}
            pageCount={pageCount}
            onPrev={() => setPage((p) => Math.max(0, p - 1))}
            onNext={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            rangeLabel={`${page * PO_PAGE_SIZE + 1}–${Math.min(openPoListFull.length, (page + 1) * PO_PAGE_SIZE)} of ${openPoListFull.length}`}
          />
        </>
      )}
    </DashboardPanel>
  );
}
