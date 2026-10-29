"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "@/components/alert";
import { ActionButton, ApprovalEvidencePanel, CounterHandoff, StatusBadge } from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import { formatMoney } from "@/lib/money";
import { usePermissions } from "@/lib/permissions";
import { useAuth } from "@/lib/use-auth";
import type { SaleDetail, SaleRefundRequest } from "../types";
import { formatDateTime } from "../utils";
import css from "../sales.module.css";

export const REFUND_REASON_OPTIONS = [
  { value: "wrong_item", label: "Wrong item" },
  { value: "changed_mind", label: "Changed their mind" },
  { value: "damaged", label: "Damaged" },
  { value: "expired", label: "Expired or short-dated" },
  { value: "adverse_reaction", label: "Adverse reaction" },
  { value: "other", label: "Other" },
] as const;

const STATUS_LABELS: Record<SaleRefundRequest["status"], string> = {
  prepared: "Prepared",
  approved: "Approved",
  executed: "Refunded",
  cancelled: "Cancelled",
};

/**
 * The remote half of a refund (D10, W4 Phase D): prepare it from the sale and, over the tenant's
 * threshold, approve it. Neither moves stock or money — the refund waits at the counter, where
 * PharmaCeylon POS executes it. There is deliberately no "refund now" button here.
 */
export function SaleRefundPanel({ sale }: { sale: SaleDetail }) {
  const { branchId, user } = useAuth();
  const { permissionKeys, canSelfApprove } = usePermissions();
  const mayPrepare = permissionKeys.includes("sales.refund");
  const mayApprove = permissionKeys.includes("returns.approve");
  const atSaleBranch = branchId === sale.branch.id;

  const [requests, setRequests] = useState<SaleRefundRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [reasonCode, setReasonCode] = useState<string>("damaged");
  const [note, setNote] = useState("");
  const approvalIds = useRef<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!atSaleBranch || !mayPrepare) return;
    try {
      setRequests(
        await apiJson<SaleRefundRequest[]>(`/sales/refund-requests?saleId=${encodeURIComponent(sale.id)}`),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load refunds for this sale");
    }
  }, [atSaleBranch, mayPrepare, sale.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = requests.find((r) => r.status === "prepared" || r.status === "approved") ?? null;
  const refundable = sale.status === "posted" || sale.status === "partially_refunded";

  async function act(path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      await apiJson(path, {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      setPreparing(false);
      await load();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function prepare() {
    const items = sale.items
      .map((item) => ({ productId: item.product.id, batchId: item.batch.id, qty: Number(qtys[item.id] ?? 0) }))
      .filter((line) => Number.isInteger(line.qty) && line.qty > 0);
    if (!items.length) {
      setError("Enter how many units come back");
      return;
    }
    if (reasonCode === "other" && !note.trim()) {
      setError("Say what the reason is when it's Other");
      return;
    }
    await act(`/sales/${encodeURIComponent(sale.id)}/refund-requests`, {
      items,
      reasonCode,
      ...(note.trim() ? { reason: note.trim() } : {}),
    });
  }

  async function approve(request: SaleRefundRequest) {
    if (!request.approvalReview) return;
    // One approval ID per displayed content, so a retried click can't approve twice.
    const slot = `${request.id}:${request.approvalReview.expectedDigest}`;
    approvalIds.current[slot] ??= crypto.randomUUID();
    await act(`/sales/refund-requests/${request.id}/approve`, {
      approvalId: approvalIds.current[slot],
      ...request.approvalReview,
    });
  }

  if (!mayPrepare) return null;

  return (
    <section className={css.card} aria-label="Refund at the counter">
      <h2 className={css.cardTitle}>Refund</h2>
      {error ? <Alert variant="error">{error}</Alert> : null}

      {!atSaleBranch ? (
        <p className={css.cellSub}>
          Switch the active branch to <strong>{sale.branch.name}</strong> to prepare or approve a refund for
          this sale.
        </p>
      ) : open ? (
        <OpenRefund
          request={open}
          branchName={sale.branch.name}
          busy={busy}
          canApprove={mayApprove && (open.requester?.id !== user?.id || canSelfApprove)}
          onApprove={() => void approve(open)}
          onCancel={() => void act(`/sales/refund-requests/${open.id}/cancel`)}
        />
      ) : refundable && preparing ? (
        <div className={css.refundForm}>
          <p className={css.cellSub}>
            Nothing moves yet: the refund waits at the counter, where the customer gets their money back.
          </p>
          {sale.items.map((item) => (
            <label key={item.id} className={css.refundLine}>
              <span>
                {item.product.name} <span className={css.cellSub}>· sold {item.qty}</span>
              </span>
              <input
                type="number"
                min={0}
                max={item.qty}
                value={qtys[item.id] ?? "0"}
                onChange={(e) => setQtys((prev) => ({ ...prev, [item.id]: e.target.value }))}
                aria-label={`Units of ${item.product.name} coming back`}
                disabled={busy}
              />
            </label>
          ))}
          <label className={css.refundLine}>
            <span>Reason</span>
            <select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} disabled={busy} aria-label="Reason">
              {REFUND_REASON_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className={css.refundLine}>
            <span>Note</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} disabled={busy} aria-label="Note" />
          </label>
          <div className={css.refundActions}>
            <ActionButton variant="secondary" onClick={() => setPreparing(false)} disabled={busy}>
              Back
            </ActionButton>
            <ActionButton onClick={() => void prepare()} disabled={busy}>
              Prepare refund
            </ActionButton>
          </div>
        </div>
      ) : refundable ? (
        <ActionButton variant="secondary" onClick={() => setPreparing(true)}>
          Prepare a refund
        </ActionButton>
      ) : (
        <p className={css.cellSub}>Nothing on this sale can be refunded.</p>
      )}

      {requests.filter((r) => r !== open).length > 0 ? (
        <ul className={css.list}>
          {requests
            .filter((r) => r !== open)
            .map((r) => (
              <li key={r.id} className={css.listItem}>
                <span className={css.cellStack}>
                  <span>
                    {r.requestNumber} <StatusBadge status={r.status} label={STATUS_LABELS[r.status]} />
                  </span>
                  <span className={css.cellSub}>
                    {formatDateTime(r.executedAt ?? r.cancelledAt ?? r.requestedAt)}
                  </span>
                </span>
                <span className={css.amount}>{formatMoney(r.amount)}</span>
              </li>
            ))}
        </ul>
      ) : null}
    </section>
  );
}

function OpenRefund({
  request,
  branchName,
  busy,
  canApprove,
  onApprove,
  onCancel,
}: {
  request: SaleRefundRequest;
  branchName: string;
  busy: boolean;
  canApprove: boolean;
  onApprove: () => void;
  onCancel: () => void;
}) {
  const needsApproval = !request.readyAtCounter;
  return (
    <>
      <div className={css.summaryRow}>
        <span>
          {request.requestNumber} · {request.lines.reduce((n, line) => n + line.qty, 0)} unit(s)
        </span>
        <span className={css.amount}>{formatMoney(request.amount)}</span>
      </div>
      <ApprovalEvidencePanel
        title="Refund approval"
        approvedVersion={request.executionApprovalId ? request.approvalVersion : null}
        currentVersion={request.approvalVersion}
        status={request.status}
        statusLabel={
          request.readyAtCounter
            ? "Waiting at the counter"
            : request.approvalRevoked
              ? "Needs fresh approval"
              : "Needs approval"
        }
        requester={request.requester ? { name: request.requester.fullName, at: request.requestedAt } : null}
        approver={
          request.approver
            ? { name: request.approver.fullName, at: request.approvedAt }
            : request.approvalRequired
              ? null
              : { name: "Not required (under the approval threshold)" }
        }
        executor={null}
      />
      {request.readyAtCounter ? (
        <CounterHandoff branchName={branchName} action="Refund the customer" whoCan={["Cashier", "Pharmacist", "Manager"]} />
      ) : null}
      <div className={css.refundActions}>
        <ActionButton variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel refund
        </ActionButton>
        {needsApproval && canApprove ? (
          <ActionButton onClick={onApprove} disabled={busy}>
            Approve refund
          </ActionButton>
        ) : null}
      </div>
    </>
  );
}
