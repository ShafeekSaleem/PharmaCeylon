"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "@/components/alert";
import { ActionButton, DataTable, PageHeader, type Column } from "@/components/ui";
import { useAuth } from "@/lib/use-auth";
import { fetchCollectedMoney } from "../services/sales-api";
import { unresolvedMoneyStatusBadge } from "../sync-badges";
import type { CollectedMoneyRow } from "../types";
import { formatDateTime, minorToMoney } from "../utils";
import { SalesReadOnlyDrawer } from "./sales-read-only-drawer";
import css from "../sales.module.css";

const PAGE_SIZE = 25;

export default function SalesCollectedMoney() {
  const { branchId } = useAuth();
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ items: [] as CollectedMoneyRow[], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CollectedMoneyRow | null>(null);
  const alive = useRef(true);

  const reload = useCallback(async () => {
    if (!branchId) return;
    setLoading(true);
    setError(null);
    try {
      const next = await fetchCollectedMoney(page, PAGE_SIZE);
      if (!alive.current) return;
      setData({ items: next.items, total: next.total });
    } catch (err) {
      if (!alive.current) return;
      setError(err instanceof Error ? err.message : "Couldn't load unresolved money");
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [branchId, page]);

  useEffect(() => {
    alive.current = true;
    void reload();
    return () => {
      alive.current = false;
    };
  }, [reload]);

  const columns: Column<CollectedMoneyRow>[] = [
    {
      key: "amount",
      header: "Amount",
      width: "8rem",
      align: "right",
      render: (row) => <span className={css.amount}>{minorToMoney(row.amountMinor)}</span>,
    },
    { key: "method", header: "Method", width: "7rem", render: (row) => row.method },
    {
      key: "status",
      header: "Status",
      width: "8rem",
      render: () => unresolvedMoneyStatusBadge(),
    },
    {
      key: "shift",
      header: "Shift",
      width: "7rem",
      render: (row) => row.shiftNumber ?? "—",
    },
    { key: "staff", header: "Staff", width: "9rem", render: (row) => row.staffName },
    {
      key: "collected",
      header: "Collected",
      width: "10rem",
      render: (row) => formatDateTime(row.collectedAt),
    },
    {
      key: "receipt",
      header: "Receipt",
      width: "9rem",
      render: (row) => row.receiptNumber ?? "—",
    },
  ];

  if (!branchId) return <p>Select a branch to review unresolved collected money.</p>;

  return (
    <div className={css.page}>
      <PageHeader
        subtitleOnly
        description="Card money collected at the counter that is not yet tied to a completed sale. Read-only until counter resolution ships."
      />
      {error ? <Alert variant="error">{error}</Alert> : null}
      <div className={css.toolbar}>
        <ActionButton variant="secondary" onClick={() => void reload()} disabled={loading}>
          Refresh
        </ActionButton>
        <span role="status">
          {loading ? "Loading unresolved money…" : `${data.total} unresolved`}
        </span>
      </div>
      <DataTable
        variant="list"
        columns={columns}
        data={data.items}
        rowKey={(row) => row.id}
        loading={loading}
        page={page}
        pageSize={PAGE_SIZE}
        total={data.total}
        onPageChange={setPage}
        onRowClick={setSelected}
        emptyTitle="No unresolved collected money"
        emptyDescription="When the counter collects payment without a matching sale, it appears here."
      />
      <SalesReadOnlyDrawer
        open={!!selected}
        title="Unresolved collected money"
        onClose={() => setSelected(null)}
      >
        {selected ? (
          <dl className={css.facts}>
            <div className={css.fact}>
              <dt>Amount</dt>
              <dd className={css.amount}>{minorToMoney(selected.amountMinor)}</dd>
            </div>
            <div className={css.fact}>
              <dt>Method</dt>
              <dd>{selected.method}</dd>
            </div>
            <div className={css.fact}>
              <dt>Status</dt>
              <dd>{unresolvedMoneyStatusBadge()}</dd>
            </div>
            <div className={css.fact}>
              <dt>Provider ref</dt>
              <dd>{selected.providerReference || "—"}</dd>
            </div>
            <div className={css.fact}>
              <dt>Approval code</dt>
              <dd>{selected.approvalCode || "—"}</dd>
            </div>
            <div className={css.fact}>
              <dt>Approved</dt>
              <dd>{selected.approvedAt ? formatDateTime(selected.approvedAt) : "—"}</dd>
            </div>
            <div className={css.fact}>
              <dt>Collected</dt>
              <dd>{formatDateTime(selected.collectedAt)}</dd>
            </div>
            <div className={css.fact}>
              <dt>Shift</dt>
              <dd>{selected.shiftNumber ?? "—"}</dd>
            </div>
            <div className={css.fact}>
              <dt>Staff</dt>
              <dd>{selected.staffName}</dd>
            </div>
            <div className={css.fact}>
              <dt>Receipt number</dt>
              <dd>{selected.receiptNumber ?? "—"}</dd>
            </div>
          </dl>
        ) : null}
      </SalesReadOnlyDrawer>
    </div>
  );
}