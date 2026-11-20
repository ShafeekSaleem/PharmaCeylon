"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Alert } from "@/components/alert";
import { ActionButton, DataTable, PageHeader, type Column } from "@/components/ui";
import { useAuth } from "@/lib/use-auth";
import { fetchIncidentNotes } from "../services/sales-api";
import { incidentNoteStatusBadge } from "../sync-badges";
import type { SaleIncidentNoteRow } from "../types";
import { formatDateTime } from "../utils";
import { SalesReadOnlyDrawer } from "./sales-read-only-drawer";
import css from "../sales.module.css";

const PAGE_SIZE = 25;

export default function SalesIncidentNotes() {
  const { branchId } = useAuth();
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ items: [] as SaleIncidentNoteRow[], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SaleIncidentNoteRow | null>(null);
  const alive = useRef(true);

  const reload = useCallback(async () => {
    if (!branchId) return;
    setLoading(true);
    setError(null);
    try {
      const next = await fetchIncidentNotes(page, PAGE_SIZE);
      if (!alive.current) return;
      setData({ items: next.items, total: next.total });
    } catch (err) {
      if (!alive.current) return;
      setError(err instanceof Error ? err.message : "Couldn't load incident notes");
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

  const columns: Column<SaleIncidentNoteRow>[] = [
    {
      key: "terminal",
      header: "Counter",
      render: (row) => (
        <span className={css.cellStack}>
          <span>{row.registerLabel ?? row.terminalLabel}</span>
          {row.registerLabel ? (
            <span className={css.cellSub}>{row.terminalLabel}</span>
          ) : null}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      width: "7rem",
      render: (row) => incidentNoteStatusBadge(row.status),
    },
    {
      key: "category",
      header: "Category",
      width: "9rem",
      render: (row) => row.incidentCategory || "—",
    },
    {
      key: "description",
      header: "Description",
      render: (row) => row.description || "—",
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

  if (!branchId) return <p>Select a branch to review incident notes.</p>;

  return (
    <div className={css.page}>
      <PageHeader
        subtitleOnly
        description="Incident notes recorded at the counter that still need a back-office look. Read-only until recovery actions ship."
      />
      {error ? <Alert variant="error">{error}</Alert> : null}
      <div className={css.toolbar}>
        <ActionButton variant="secondary" onClick={() => void reload()} disabled={loading}>
          Refresh
        </ActionButton>
        <span role="status">
          {loading ? "Loading incident notes…" : `${data.total} in the queue`}
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
        emptyTitle="No incident notes to review"
        emptyDescription="When the counter records an incident, it appears here for review."
      />
      <SalesReadOnlyDrawer
        open={!!selected}
        title={selected ? `Incident ${selected.recordId}` : "Incident note"}
        onClose={() => setSelected(null)}
      >
        {selected ? (
          <dl className={css.facts}>
            <div className={css.fact}>
              <dt>Counter</dt>
              <dd>{selected.registerLabel ?? selected.terminalLabel}</dd>
            </div>
            <div className={css.fact}>
              <dt>Till</dt>
              <dd>{selected.registerLabel ? selected.terminalLabel : "—"}</dd>
            </div>
            <div className={css.fact}>
              <dt>Status</dt>
              <dd>{incidentNoteStatusBadge(selected.status)}</dd>
            </div>
            {selected.status === "held" && selected.heldReason ? (
              <div className={`${css.fact} ${css.factSpan}`}>
                <dt>Held reason</dt>
                <dd>{selected.heldReason}</dd>
              </div>
            ) : null}
            <div className={css.fact}>
              <dt>Category</dt>
              <dd>{selected.incidentCategory || "—"}</dd>
            </div>
            <div className={`${css.fact} ${css.factSpan}`}>
              <dt>Description</dt>
              <dd>{selected.description || "—"}</dd>
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
              <dt>Recorded by</dt>
              <dd>{selected.recordedBy?.fullName ?? "—"}</dd>
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
          </dl>
        ) : null}
      </SalesReadOnlyDrawer>
    </div>
  );
}