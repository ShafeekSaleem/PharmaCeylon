"use client";

import { useCallback, useEffect, useState } from "react";
import {
  COUNTER_MISMATCH_PROBLEM_LABEL,
  type CounterMismatchKind,
  type CounterMismatchReport,
} from "@pharmaceylon/shared";
import { Alert } from "@/components/alert";
import { ModalButton } from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import css from "./counter-mismatch-notes.module.css";

type Props = {
  kind: CounterMismatchKind;
  documentId: string;
  /** The viewer may approve this document here, so may answer the report. */
  canAnswer: boolean;
  /** Called after a report is answered, so the page can reload the document. */
  onAnswered?: () => void;
};

const when = (at: string | null) =>
  at ? new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";

function what(report: CounterMismatchReport) {
  const label = COUNTER_MISMATCH_PROBLEM_LABEL[report.problem];
  const count =
    report.countedQty == null ? "" : `: ${report.countedQty} ${report.countUnit ?? "units"}`;
  return `${report.lineLabel ?? "Not on the delivery note"} · ${label}${count}`;
}

/**
 * P6 #52 decision 1: what the counter said doesn't match this approved document. An open
 * report holds the approval the counter saw: approving a corrected version replaces it, or the
 * approver keeps the document as it is here. A transfer in is never held.
 */
export function CounterMismatchNotes({ kind, documentId, canAnswer, onAnswered }: Props) {
  const [reports, setReports] = useState<CounterMismatchReport[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ kind, documentId });
      const rows = await apiJson<CounterMismatchReport[]>(`/counter-work/mismatches?${params}`);
      setReports(Array.isArray(rows) ? rows : []);
    } catch {
      setReports([]);
    }
  }, [kind, documentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = reports.filter((r) => r.status === "open" && (r.holding || kind === "transfer_receive"));
  if (!open.length) return null;

  async function keep(report: CounterMismatchReport) {
    setBusy(report.id);
    setError(null);
    try {
      await apiJson(`/counter-work/mismatches/${report.id}/dismiss`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: notes[report.id]?.trim() || null }),
      });
      await load();
      onAnswered?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not answer the report");
    } finally {
      setBusy(null);
    }
  }

  const holds = kind !== "transfer_receive";
  return (
    <Alert variant="warning" className={css.panel}>
      <strong>
        {open.length === 1 ? "The counter says something doesn't match" : `The counter sent ${open.length} reports`}
      </strong>
      <p className={css.lead}>
        {holds
          ? "Nothing posts at the counter until you approve a corrected version, or keep this as approved."
          : "The counter can still receive what arrived. Close the rest below once you know what happened to it."}
      </p>
      {error ? <Alert variant="error">{error}</Alert> : null}
      <ul className={css.list}>
        {open.map((report) => (
          <li key={report.id} className={css.item}>
            <div className={css.what}>{what(report)}</div>
            {report.note ? <div className={css.note}>&ldquo;{report.note}&rdquo;</div> : null}
            <div className={css.meta}>
              {report.reported.name ?? "Counter"} · {when(report.reported.at)}
            </div>
            {canAnswer ? (
              <div className={css.answer}>
                <input
                  className={css.input}
                  placeholder="Note for the counter (optional)"
                  maxLength={500}
                  value={notes[report.id] ?? ""}
                  onChange={(e) => setNotes((prev) => ({ ...prev, [report.id]: e.target.value }))}
                  aria-label="Note for the counter"
                  disabled={busy !== null}
                />
                <ModalButton
                  variant="secondary"
                  onClick={() => void keep(report)}
                  loading={busy === report.id}
                  disabled={busy !== null}
                >
                  {holds ? "Keep as approved" : "Mark as read"}
                </ModalButton>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </Alert>
  );
}
