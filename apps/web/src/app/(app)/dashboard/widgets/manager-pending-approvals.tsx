"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { IconClipboardList, IconRotateCcw, IconShoppingCart, IconTruck } from "@/components/icons";
import { DashboardPanel } from "../components/dashboard-panel";
import { PaginationControls } from "../components/pagination-controls";
import type { DashboardData } from "../hooks/use-dashboard-data";
import { paginate } from "../lib/paginate";
import css from "../dashboard.module.css";

const APPROVALS_PAGE_SIZE = 4;

type ApprovalItem = {
  key: string;
  kind: "po" | "transfer" | "return";
  number: string;
  detail: string;
  href: string;
};

export function ManagerPendingApprovalsWidget({ data }: { data: DashboardData }) {
  const { pendingApprovalListFull, transfers, goodsReturns } = data;

  const approvalItems: ApprovalItem[] = useMemo(() => {
    const items: ApprovalItem[] = [];
    for (const po of pendingApprovalListFull) {
      items.push({
        key: `po-${po.id}`,
        kind: "po",
        number: po.poNumber,
        detail: po.supplier.name,
        href: `/purchasing?po=${po.id}`,
      });
    }
    for (const t of transfers.filter((row) => row.status === "requested")) {
      items.push({
        key: `tr-${t.id}`,
        kind: "transfer",
        number: t.transferNumber,
        detail: [t.fromBranch?.name, t.toBranch?.name].filter(Boolean).join(" → ") || "Transfer",
        href: `/transfers?transfer=${t.id}`,
      });
    }
    for (const r of goodsReturns.filter((row) => row.status === "pending_approval")) {
      items.push({
        key: `ret-${r.id}`,
        kind: "return",
        number: r.returnNumber,
        detail: r.type ? r.type.replace(/_/g, " ") : "Return",
        href: `/returns?return=${r.id}`,
      });
    }
    return items;
  }, [pendingApprovalListFull, transfers, goodsReturns]);

  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(approvalItems.length / APPROVALS_PAGE_SIZE));

  return (
    <DashboardPanel title="Pending Approvals" icon={<IconClipboardList size={15} />}>
      {approvalItems.length === 0 ? (
        <p className={css.emptyState}>No pending approvals right now.</p>
      ) : (
        <>
          <ul className={css.pipelineList}>
            {paginate(approvalItems, page, APPROVALS_PAGE_SIZE).map((item) => (
              <li key={item.key}>
                <Link href={item.href}>
                  <span className={`${css.pipelineIcon} ${css[`pipelineIcon_${item.kind}`]}`} aria-hidden>
                    {item.kind === "po" ? (
                      <IconShoppingCart size={14} strokeWidth={1.75} />
                    ) : item.kind === "transfer" ? (
                      <IconTruck size={14} strokeWidth={1.75} />
                    ) : (
                      <IconRotateCcw size={14} strokeWidth={1.75} />
                    )}
                  </span>
                  <span className={css.pipelineRowBody}>
                    <strong>{item.number}</strong>
                    <span className={css.muted}>{item.detail}</span>
                  </span>
                  <span className={css.approvalKindPill}>
                    {item.kind === "po" ? "PO" : item.kind === "transfer" ? "Transfer" : "Return"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <PaginationControls
            page={page}
            pageCount={pageCount}
            onPrev={() => setPage((p) => Math.max(0, p - 1))}
            onNext={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            rangeLabel={`${page * APPROVALS_PAGE_SIZE + 1}–${Math.min(approvalItems.length, (page + 1) * APPROVALS_PAGE_SIZE)} of ${approvalItems.length}`}
          />
        </>
      )}
    </DashboardPanel>
  );
}
