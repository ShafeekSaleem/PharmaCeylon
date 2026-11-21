"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Alert } from "@/components/alert";
import { ActionButton, DataTable, PageHeader, SegmentedTabs, type Column } from "@/components/ui";
import { useAuth } from "@/lib/use-auth";
import { isSalesQueueForbidden, SalesQueueAccessDenied } from "./sales-queue-access";
import { fetchIncidentNotes, type IncidentNotesQueueStatus } from "../services/sales-api";
import { incidentNoteStatusBadge } from "../sync-badges";
import { supportHeldReasonLabel } from "../support-labels";
import type { SaleIncidentNoteRow } from "../types";
import { formatDateTime, incidentNoteAge } from "../utils";
import { SalesReadOnlyDrawer } from "./sales-read-only-drawer";
import css from "../sales.module.css";

const PAGE_SIZE = 25;

const STATUS_TABS: { value: IncidentNotesQueueStatus; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "held", label: "Held" },
];

export default function SalesIncidentNotes() {
  const { branchId } = useAuth();
  const [status, setStatus] = useState<IncidentNotesQueueStatus>("open");
  const [page, setPage] = useState(1);
  const [data, setData] = useState({
    items: [] as SaleIncidentNoteRow[],
    total: 0,
    asOf: "",
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [selected, setSelected] = useState<SaleIncidentNoteRow | null>(null);
  const loadGen = useRef(0);
  const prevBranchId = useRef<string | null>(branchId);

  useEffect(() => {
    if (prevBranchId.current === branchId) return;
    prevBranchId.current = branchId;
    loadGen.current += 1;
    setPage(1);
    setSelected(null);
    setData({ items: [], total: 0, asOf: "" });
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
      const next = await fetchIncidentNotes(page, PAGE_SIZE, status, "recordedAt");
      if (generation !== loadGen.current) return;
      setData({ items: next.items, total: next.total, asOf: next.asOf });
    } catch (err) {
      if (generation !== loadGen.current) return;
      if (isSalesQueueForbidden(err)) {
        setPermissionDenied(true);
        return;
      }
      setError(err instanceof Error ? err.message : "Couldn't load incident notes");
    } finally {
      if (generation === loadGen.current) setLoading(false);
    }
  }, [branchId, page, status]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onStatusChange = (next: IncidentNotesQueueStatus) => {
    setStatus(next);
    setPage(1);
    setSelected(null);
  };

  const columns: Column<SaleIncidentNoteRow>[] = [
    {
      key: "terminal",
      header: "Terminal",
      width: "8rem",
      render: (row) => row.terminalLabel,
    },
    {
      key: "till",
      header: "Till",
      width: "8rem",
      render: (row) => row.registerLabel ?? "—",
    },
    {
      key: "status",
      header: "Status",
      width: "7rem",
      render: (row) => incidentNoteStatusBadge(row.status),
    },
    {
      key: "recorded",
      header: "Recorded",
      width: "10rem",
      render: (row) => formatDateTime(row.recordedAt),
    },
    {
      key: "age",
      header: "Age",
      width: "8rem",
      render: (row) => {
        const age = incidentNoteAge(row.receivedAt, data.asOf || new Date().toISOString());
        return (
          <span className={age.late ? css.queueAgeLate : undefined}>{age.text}</span>
        );
      },
    },
  ];

  if (!branchId) return <p>Select a branch to review incident notes.</p>;
  if (permissionDenied) {
    return (
      <div className={css.page}>
        <PageHeader
          subtitleOnly
          description="Incident notes recorded at the counter that still need a back-office look."
        />
        <SalesQueueAccessDenied />
      </div>
    );
  }

  return (
    <div className={css.page}>
      <PageHeader
        subtitleOnly
        description="Incident notes recorded at the counter that still need a back-office look. Read-only until recovery actions ship."
      />
      {error ? <Alert variant="error">{error}</Alert> : null}
      <div className={css.toolbar}>
        <div className={css.queueStatusToggle}>
          <SegmentedTabs
            active={status}
            items={STATUS_TABS.map((tab) => ({ id: tab.value, label: tab.label }))}
            onChange={onStatusChange}
            ariaLabel="Incident note status"
          />
          <ActionButton variant="secondary" onClick={() => void reload()} disabled={loading}>
            Refresh
          </ActionButton>
        </div>
        <span role="status">
          {loading ? "Loading incident notes…" : `${data.total} in the queue`}
        </span>
      </div>
      <p className={css.queueLater}>Oldest first</p>
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
              <dt>Terminal</dt>
              <dd>{selected.terminalLabel}</dd>
            </div>
            <div className={css.fact}>
              <dt>Till</dt>
              <dd>{selected.registerLabel ?? "—"}</dd>
            </div>
            <div className={css.fact}>
              <dt>Status</dt>
              <dd>{incidentNoteStatusBadge(selected.status)}</dd>
            </div>
            {selected.status === "held" && selected.heldReason ? (
              <div className={`${css.fact} ${css.factSpan}`}>
                <dt>Held reason</dt>
                <dd>{supportHeldReasonLabel(selected.heldReason)}</dd>
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