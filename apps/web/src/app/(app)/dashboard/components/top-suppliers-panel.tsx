"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { IconTruck } from "@/components/icons";
import { apiJson } from "@/lib/auth-client";
import { formatMoney } from "@/app/(app)/inventory/utils";
import { StatusBadge } from "@/components/ui";
import { DashboardPanel } from "./dashboard-panel";
import css from "../dashboard.module.css";

type SupplierSpendResponse = {
  suppliers: Array<{
    supplierId: string;
    name: string;
    code: string;
    outstanding: number;
    invoiceCount: number;
    overduePoCount: number;
  }>;
  totalOutstanding: number;
  totalSuppliers: number;
  totalOverduePos: number;
};

export function TopSuppliersPanel() {
  const [data, setData] = useState<SupplierSpendResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void apiJson<SupplierSpendResponse>("/analytics/supplier-spend-summary?limit=6")
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <DashboardPanel
      title="Top Suppliers"
      subtitle="By outstanding payable"
      icon={<IconTruck size={15} />}
      compact
      footerHref="/suppliers"
      footerLabel="Open suppliers →"
      footerMeta={
        data
          ? `${formatMoney(data.totalOutstanding)} across ${data.totalSuppliers} supplier${data.totalSuppliers === 1 ? "" : "s"}`
          : undefined
      }
    >
      {loading && !data ? (
        <p className={css.emptyState}>Loading suppliers…</p>
      ) : !data || data.suppliers.length === 0 ? (
        <p className={css.emptyState}>No open supplier balances.</p>
      ) : (
        <ul className={css.pipelineList}>
          {data.suppliers.map((s) => (
            <li key={s.supplierId}>
              <Link href={`/suppliers?supplier=${encodeURIComponent(s.supplierId)}`}>
                <span className={`${css.pipelineIcon} ${css.pipelineIcon_po}`} aria-hidden>
                  <IconTruck size={14} strokeWidth={1.75} />
                </span>
                <span className={css.pipelineRowBody}>
                  <strong>{s.name}</strong>
                  <span className={css.muted}>
                    {s.code} · {s.invoiceCount} open invoice{s.invoiceCount === 1 ? "" : "s"}
                  </span>
                  {s.overduePoCount > 0 ? (
                    <StatusBadge
                      status="overdue"
                      label={`${s.overduePoCount} overdue PO${s.overduePoCount === 1 ? "" : "s"}`}
                      variant="danger"
                    />
                  ) : null}
                </span>
                <span className={css.teamNum}>{formatMoney(s.outstanding)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </DashboardPanel>
  );
}
