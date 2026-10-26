"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ModalButton } from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";
import { formatMoney } from "@/lib/money";
import { usePermissions } from "@/lib/permissions";
import { ConfirmDialog } from "../../products/components/confirm-dialog";
import { useInventoryAccess } from "../hooks/use-inventory-access";
import css from "../inventory.module.css";

type HeldWriteOff = {
  id: string;
  status: "awaiting_approval" | "approved" | "accepted" | "rejected";
  approvalReview: { expectedVersion: number; expectedDigest: string };
  executionApprovalId: string | null;
  kindLabel: string;
  qty: number;
  value: string | null;
  note: string | null;
  requestReason?: string | null;
  fromQuarantine?: boolean;
  product: { id: string; sku: string; name: string };
  batch: { id: string; batchNo: string };
  requester: { id: string; fullName: string };
  requestedAt: string;
};

type Summary = {
  since: string;
  rows: Array<{ kind: string; label: string; units: number; value: string | null }>;
};

type Props = {
  /** `?heldAdjustment=` from a notification — that one is highlighted. */
  focusId?: string | null;
  onChanged: (message: string) => void;
  onError: (message: string) => void;
};

/**
 * Write-offs waiting for approval at this branch, with Accept and Reject for those who may write
 * off stock, and this month's write-offs by what happened underneath.
 */
export function WriteOffPanel({ focusId, onChanged, onError }: Props) {
  const { branchId, user } = useAuth();
  const access = useInventoryAccess();
  const { canSelfApprove } = usePermissions();
  const approvalIds = useRef(new Map<string, string>());
  const [held, setHeld] = useState<HeldWriteOff[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState<HeldWriteOff | null>(null);
  const [reason, setReason] = useState("");

  const load = useCallback(() => {
    if (!branchId) return;
    apiJson<HeldWriteOff[]>("/inventory/held-adjustments")
      .then(setHeld)
      .catch(() => setHeld([]));
    apiJson<Summary>("/inventory/write-offs/summary")
      .then(setSummary)
      .catch(() => setSummary(null));
  }, [branchId]);
  useEffect(load, [load]);

  async function decide(row: HeldWriteOff, action: "accept" | "reject" | "post") {
    setBusy(true);
    try {
      const key = `${row.id}:${row.approvalReview.expectedDigest}:${row.executionApprovalId ?? ""}`;
      if (action === "accept" && !approvalIds.current.has(key)) approvalIds.current.set(key, crypto.randomUUID());
      await apiJson(`/inventory/held-adjustments/${row.id}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "reject" ? { reason } : action === "accept"
          ? { approvalId: approvalIds.current.get(key), ...row.approvalReview } : { approvalId: row.executionApprovalId }),
      });
      approvalIds.current.delete(key);
      setRejecting(null);
      setReason("");
      load();
      onChanged(
        action === "accept"
          ? "Write-off approved. Stock changes only when posted."
          : action === "post" ? `Wrote off ${row.qty} × ${row.product.name}.`
          : `Write-off rejected; ${row.requester.fullName} has been told why.`,
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : "Couldn't decide the write-off");
    } finally {
      setBusy(false);
    }
  }

  const writtenOff = summary?.rows ?? [];
  if (held.length === 0 && writtenOff.length === 0) return null;

  return (
    <section className={css.writeOffPanel} aria-label="Write-offs">
      {held.length > 0 ? (
        <>
          <h3 className={css.adjStepTitle}>
            {held.length} write-off{held.length === 1 ? "" : "s"} awaiting approval or posting
          </h3>
          <ul className={css.writeOffList}>
            {held.map((row) => (
              <li
                key={row.id}
                className={`${css.writeOffRow}${focusId === row.id ? ` ${css.writeOffFocus}` : ""}`}
              >
                <div className={css.writeOffMain}>
                  <strong>
                    {row.product.name} · {row.qty} unit{row.qty === 1 ? "" : "s"}
                  </strong>
                  <span className={css.fieldHint}>
                    {row.status === "approved" ? "Approved, awaiting posting · " : "Awaiting approval · "}{row.kindLabel} · batch {row.batch.batchNo} · {row.requester.fullName}
                    {row.value != null ? ` · ${formatMoney(Number(row.value))}` : ""}
                    {row.requestReason ? ` · ${row.requestReason}` : ""}
                    {row.note && row.note !== row.requestReason ? ` · Note: ${row.note}` : ""}
                    {row.fromQuarantine ? " · From quarantine only" : ""}
                  </span>
                </div>
                {access.canWriteOff ? <div className={css.writeOffActions}>
                  <ModalButton variant="danger" onClick={() => setRejecting(row)} disabled={busy}>Reject</ModalButton>
                  {row.requester.id !== user?.id || canSelfApprove ? (
                    <ModalButton onClick={() => void decide(row, "accept")} loading={busy}>
                      {row.status === "approved" ? "Review approval" : "Approve write-off"}
                    </ModalButton>
                  ) : <span className={css.fieldHint}>Waiting for someone else to approve it</span>}
                  {row.status === "approved" && row.executionApprovalId ? <ModalButton variant="primary" onClick={() => void decide(row, "post")} loading={busy}>
                    Post write-off
                  </ModalButton> : null}
                </div> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {writtenOff.length > 0 ? (
        <p className={css.writeOffSummary}>
          <span className={css.fieldHint}>Written off this month:</span>{" "}
          {writtenOff
            .map(
              (row) =>
                `${row.label} ${row.units} unit${row.units === 1 ? "" : "s"}${row.value != null ? ` (${formatMoney(Number(row.value))})` : ""}`,
            )
            .join(" · ")}
        </p>
      ) : null}

      <ConfirmDialog
        open={rejecting !== null}
        title="Reject this write-off?"
        confirmLabel="Reject"
        cancelLabel="Keep it waiting"
        variant="danger"
        loading={busy}
        confirmDisabled={!reason.trim()}
        onCancel={() => {
          if (busy) return;
          setRejecting(null);
          setReason("");
        }}
        onConfirm={() => rejecting && void decide(rejecting, "reject")}
      >
        <p>Nothing is written off. The person who entered it is told why.</p>
        <textarea
          className={css.textarea}
          aria-label="Reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={512}
          placeholder="e.g. Found the units on the back shelf"
        />
      </ConfirmDialog>
    </section>
  );
}
