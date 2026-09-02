"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { IconShoppingCart, IconTruck } from "@/components/icons";
import { StatusBadge } from "@/components/ui";
import { DashboardPanel } from "../components/dashboard-panel";
import { PaginationControls } from "../components/pagination-controls";
import type { DashboardData } from "../hooks/use-dashboard-data";
import { paginate } from "../lib/paginate";
import css from "../dashboard.module.css";

const PIPELINE_PAGE_SIZE = 4;

export function ManagerTransferPoPipelineWidget({ data }: { data: DashboardData }) {
  const { openPoListFull, transfers } = data;

  const pipelineItems = useMemo(
    () => [
      ...openPoListFull.map((po) => ({
        key: `po-${po.id}`,
        kind: "po" as const,
        number: po.poNumber,
        detail: po.supplier.name,
        status: po.status,
        href: `/purchasing?po=${po.id}`,
      })),
      ...transfers
        .filter((t) => ["requested", "approved", "in_transit", "in_progress"].includes(t.status))
        .map((t) => ({
          key: `tr-${t.id}`,
          kind: "transfer" as const,
          number: t.transferNumber,
          detail: [t.fromBranch?.name, t.toBranch?.name].filter(Boolean).join(" → ") || "Transfer",
          status: t.status,
          href: `/transfers?transfer=${t.id}`,
        })),
    ],
    [openPoListFull, transfers],
  );
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(pipelineItems.length / PIPELINE_PAGE_SIZE));

  return (
    <DashboardPanel title="Transfer & PO Pipeline" footerHref="/purchasing" footerLabel="Open pipeline →">
      {pipelineItems.length === 0 ? (
        <p className={css.emptyState}>No open pipeline items.</p>
      ) : (
        <>
          <ul className={css.pipelineList}>
            {paginate(pipelineItems, page, PIPELINE_PAGE_SIZE).map((item) => (
              <li key={item.key}>
                <Link href={item.href}>
                  <span
                    className={`${css.pipelineIcon} ${css[`pipelineIcon_${item.kind === "po" ? "po" : "transfer"}`]}`}
                    aria-hidden
                  >
                    {item.kind === "po" ? (
                      <IconShoppingCart size={14} strokeWidth={1.75} />
                    ) : (
                      <IconTruck size={14} strokeWidth={1.75} />
                    )}
                  </span>
                  <span className={css.pipelineRowBody}>
                    <strong>{item.number}</strong>
                    <span className={css.muted}>{item.detail}</span>
                  </span>
                  <StatusBadge status={item.status} />
                </Link>
              </li>
            ))}
          </ul>
          <PaginationControls
            page={page}
            pageCount={pageCount}
            onPrev={() => setPage((p) => Math.max(0, p - 1))}
            onNext={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            rangeLabel={`${page * PIPELINE_PAGE_SIZE + 1}–${Math.min(pipelineItems.length, (page + 1) * PIPELINE_PAGE_SIZE)} of ${pipelineItems.length}`}
          />
        </>
      )}
    </DashboardPanel>
  );
}
