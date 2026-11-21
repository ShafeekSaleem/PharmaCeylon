"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Alert } from "@/components/alert";
import { ActionButton, DataTable, PageHeader, type Column } from "@/components/ui";
import { useAuth } from "@/lib/use-auth";
import { isSalesQueueForbidden, SalesQueueAccessDenied } from "./sales-queue-access";
import { fetchPaymentRecovery } from "../services/sales-api";
import { clearsOnUploadBadge } from "../sync-badges";
import type { PaymentRecoveryRow } from "../types";
import { supportHeldReasonLabel } from "../support-labels";
import { formatDateTime, minorToMoney } from "../utils";
import { SalesReadOnlyDrawer } from "./sales-read-only-drawer";
import css from "../sales.module.css";

const PAGE_SIZE = 25;

export default function SalesPaymentRecovery() {
  const { branchId } = useAuth();
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ items: [] as PaymentRecoveryRow[], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [selected, setSelected] = useState<PaymentRecoveryRow | null>(null);
  const loadGen = useRef(0);
  const prevBranchId = useRef<string | null>(branchId);

  useEffect(() => {
    if (prevBranchId.current === branchId) return;
    prevBranchId.current = branchId;
    loadGen.current += 1;
    setPage(1);
    setSelected(null);
    setData({ items: [], total: 0 });
    setError(null);
    setPermissionDenied(false);
  }, [branchId]);

  const reload = useCallback(async () => {
    if (!branchId) return;
    const generation = ++loadGen.current;
    setLoading(true);
    setError(null);
    setPermissionDenied(false);
    try {
      const next = await fetchPaymentRecovery(page, PAGE_SIZE);
      if (generation !== loadGen.current) return;
      setData({ items: next.items, total: next.total });
    } catch (err) {
      if (generation !== loadGen.current) return;
      if (isSalesQueueForbidden(err)) {
        setPermissionDenied(true);
        return;
      }
      setError(err instanceof Error ? err.message : "Couldn't load payment recovery");
    } finally {
      if (generation === loadGen.current) setLoading(false);
    }
  }, [branchId, page]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const columns: Column<PaymentRecoveryRow>[] = [
    { key: "terminal", header: "Counter", width: "8rem", render: (row) => row.terminalLabel },
    {
      key: "reason",
      header: "Held reason",
      width: "9rem",
      render: (row) => supportHeldReasonLabel(row.heldReason),
    },
    {
      key: "amount",
      header: "Amount",
      width: "8rem",
      align: "right",
      render: (row) => <span className={css.amount}>{minorToMoney(row.amountMinor)}</span>,
    },
    {
      key: "clears",
      header: "Clears on upload",
      width: "10.75rem",
      render: (row) => clearsOnUploadBadge(row.clearsOnUpload),
    },
    {
      key: "received",
      header: "Received",
      width: "10rem",
      render: (row) => formatDateTime(row.receivedAt),
    },
    {
      key: "sale",
      header: "Linked sale",
      width: "9rem",
      render: (row) =>
        row.sale ? (
          <Link href={`/sales/${row.sale.id}`} onClick={(e) => e.stopPropagation()}>
            {row.sale.invoiceNo}
          </Link>
        ) : (
          "—"
        ),
    },
  ];

  if (!branchId) return <p>Select a branch to review payment recovery.</p>;
  if (permissionDenied) {
    return (
      <div className={css.page}>
        <PageHeader
          subtitleOnly
          description="Card payments held at the counter for recovery."
        />
        <SalesQueueAccessDenied />
      </div>
    );
  }

  return (
    <div className={css.page}>
      <PageHeader
        subtitleOnly
        description="Card payments held at the counter for recovery. Read-only until manager actions ship."
      />
      {error ? <Alert variant="error">{error}</Alert> : null}
      <div className={css.toolbar}>
        <ActionButton variant="secondary" onClick={() => void reload()} disabled={loading}>
          Refresh
        </ActionButton>
        <span role="status">
          {loading ? "Loading payment recovery…" : `${data.total} in the queue`}
        </span>
      </div>
      <DataTable
        variant="list"
        columns={columns}
        data={data.items}
        rowKey={(row) => row.attemptId}
        loading={loading}
        page={page}
        pageSize={PAGE_SIZE}
        total={data.total}
        onPageChange={setPage}
        onRowClick={setSelected}
        emptyTitle="No payment recovery items"
        emptyDescription="Held card payments show here when they need a manager review."
      />
      <SalesReadOnlyDrawer
        open={!!selected}
        title={selected ? `Payment recovery` : "Payment recovery"}
        onClose={() => setSelected(null)}
      >
        {selected ? (
          <dl className={css.facts}>
            <div className={css.fact}>
              <dt>Counter</dt>
              <dd>{selected.terminalLabel}</dd>
            </div>
            <div className={css.fact}>
              <dt>Held reason</dt>
              <dd>{supportHeldReasonLabel(selected.heldReason)}</dd>
            </div>
            <div className={`${css.fact} ${css.factSpan}`}>
              <dt>Explanation</dt>
              <dd>{selected.explanation}</dd>
            </div>
            <div className={css.fact}>
              <dt>Amount</dt>
              <dd className={css.amount}>{minorToMoney(selected.amountMinor)}</dd>
            </div>
            <div className={css.fact}>
              <dt>Provider ref</dt>
              <dd>{selected.providerReference || "—"}</dd>
            </div>
            <div className={css.fact}>
              <dt>Approval code</dt>
              <dd>{selected.approvalCode || "—"}</dd>
            </div>
            <div className={`${css.fact} ${css.factSpan}`}>
              <dt>Card state</dt>
              <dd>{selected.cardState || "—"}</dd>
            </div>
            <div className={css.fact}>
              <dt>Recorded</dt>
              <dd>{formatDateTime(selected.recordedAt)}</dd>
            </div>
            <div className={css.fact}>
              <dt>Received</dt>
              <dd>{formatDateTime(selected.receivedAt)}</dd>
            </div>
            <div className={css.fact}>
              <dt>Linked sale</dt>
              <dd>
                {selected.sale ? (
                  <Link href={`/sales/${selected.sale.id}`}>{selected.sale.invoiceNo}</Link>
                ) : (
                  "—"
                )}
              </dd>
            </div>
            <div className={css.fact}>
              <dt>Clears on upload</dt>
              <dd>
                {selected.clearsOnUpload ? (
                  clearsOnUploadBadge(true)
                ) : (
                  <span className={css.muted}>No</span>
                )}
              </dd>
            </div>
          </dl>
        ) : null}
      </SalesReadOnlyDrawer>
    </div>
  );
}