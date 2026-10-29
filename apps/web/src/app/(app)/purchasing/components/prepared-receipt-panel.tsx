"use client";

import { useState } from "react";
import { ApprovalEvidencePanel, CounterHandoff, ModalButton } from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import { ConfirmDialog } from "../../products/components/confirm-dialog";
import type { PreparedReceipt, PurchaseOrderDetail } from "../types";
import { formatMoney } from "../utils";
import { heldLineUnits } from "./held-delivery-banner";
import css from "../purchasing.module.css";

type Props = {
  receipt: PreparedReceipt;
  order: PurchaseOrderDetail;
  branchName: string;
  canApprove: boolean;
  canCancel: boolean;
  canPost: boolean;
  /** The branch books goods in at PharmaCeylon POS (live, fallback, or not yet known). */
  counterOnly: boolean;
  onChanged: () => void | Promise<void>;
};

type Intent = { kind: "approve"; approvalId: string } | { kind: "post" } | { kind: "cancel" };

const STATUS_LABEL: Record<PreparedReceipt["status"], string> = {
  draft: "Awaiting approval",
  approved: "Approved — awaiting the goods",
  posted: "Received",
  cancelled: "Cancelled",
};

/**
 * A delivery prepared remotely from the supplier's note. Approving it records exactly what will
 * be booked in and changes nothing else; receiving it is the counter's step, on the day the
 * goods are there. At a branch that books goods in at PharmaCeylon POS the web only approves.
 */
export function PreparedReceiptPanel({
  receipt,
  order,
  branchName,
  canApprove,
  canCancel,
  canPost,
  counterOnly,
  onChanged,
}: Props) {
  const [intent, setIntent] = useState<Intent | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const itemByProduct = new Map(order.items.map((item) => [item.productId, item]));
  const approved = receipt.status === "approved" && !!receipt.executionApprovalId;
  const showApprove = canApprove && receipt.status === "draft" && !!receipt.approvalReview;
  const showPost = canPost && approved && !counterOnly;

  async function confirm() {
    if (!intent) return;
    setBusy(true);
    setError(null);
    const path =
      intent.kind === "approve" ? "approve" : intent.kind === "post" ? "post" : "cancel";
    const body =
      intent.kind === "approve"
        ? { approvalId: intent.approvalId, ...receipt.approvalReview }
        : intent.kind === "post"
          ? { approvalId: receipt.executionApprovalId }
          : { reason: reason.trim() };
    try {
      await apiJson(`/purchasing/prepared-receipts/${receipt.id}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setIntent(null);
      setReason("");
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={css.heldBanner} aria-labelledby={`prepared-${receipt.id}`}>
      <ConfirmDialog
        open={intent !== null}
        title={
          intent?.kind === "approve"
            ? "Approve this prepared delivery?"
            : intent?.kind === "post"
              ? "Receive this delivery into stock?"
              : "Cancel this prepared delivery?"
        }
        variant={intent?.kind === "cancel" ? "danger" : "primary"}
        confirmLabel={
          intent?.kind === "approve" ? "Approve delivery" : intent?.kind === "post" ? "Post receipt" : "Cancel delivery"
        }
        loading={busy}
        onCancel={() => !busy && setIntent(null)}
        onConfirm={() => {
          if (intent?.kind === "cancel" && !reason.trim()) return;
          void confirm();
        }}
      >
        {intent?.kind === "approve" ? (
          <p>
            Approval confirms the delivery shown here, its batches, quantities and exceptions.
            Stock and the supplier balance change only when the goods are received at {branchName}.
          </p>
        ) : intent?.kind === "post" ? (
          <p>
            This receives the approved quantities into stock today, holds damaged units in
            quarantine and records what is owed to the supplier.
          </p>
        ) : (
          <label className={css.checkboxRow}>
            Why?
            <input
              aria-label="Reason for cancelling"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
            />
          </label>
        )}
      </ConfirmDialog>

      <div className={css.heldBannerHead}>
        <div>
          <h3 id={`prepared-${receipt.id}`} className={css.heldBannerTitle}>
            Prepared delivery · {STATUS_LABEL[receipt.status]}
          </h3>
          <p className={css.heldBannerMeta}>
            {receipt.delivery.supplierDeliveryNote ? `Note ${receipt.delivery.supplierDeliveryNote}` : "No delivery note"}
            {receipt.delivery.acceptOverDelivery ? " · accepts more than ordered" : ""}
            {receipt.delivery.acceptPriceVariance ? " · accepts a higher price" : ""}
            {receipt.delivery.updateSupplierPrice ? " · updates the supplier's agreed prices" : ""}
            {receipt.notes ? ` · ${receipt.notes}` : ""}
          </p>
        </div>
        {showApprove || showPost || (canCancel && !receipt.goodsReceiptId) ? (
          <div className={css.heldBannerActions}>
            {canCancel && !receipt.goodsReceiptId ? (
              <ModalButton variant="danger" onClick={() => setIntent({ kind: "cancel" })} disabled={busy}>
                Cancel
              </ModalButton>
            ) : null}
            {showApprove ? (
              <span
                data-tooltip={
                  receipt.selfApprovalBlocked
                    ? "You prepared this delivery, and your role can't approve its own requests. Ask another approver."
                    : undefined
                }
              >
                <ModalButton
                  variant="primary"
                  onClick={() => setIntent({ kind: "approve", approvalId: crypto.randomUUID() })}
                  disabled={busy || receipt.selfApprovalBlocked}
                >
                  Approve
                </ModalButton>
              </span>
            ) : null}
            {showPost ? (
              <ModalButton variant="primary" onClick={() => setIntent({ kind: "post" })} disabled={busy}>
                Post receipt
              </ModalButton>
            ) : null}
          </div>
        ) : null}
      </div>

      {error ? <p className={css.heldFlag} role="alert">{error}</p> : null}
      {!receipt.orderOpen ? (
        <p className={css.heldBannerMeta}>
          The order is no longer open for receiving. Cancel this prepared delivery.
        </p>
      ) : null}

      <div className={css.heldTableScroll}>
        <table className={css.heldTable}>
          <thead>
            <tr>
              <th>Product</th>
              <th className={css.heldNum}>Outstanding</th>
              <th className={css.heldNum}>Arriving</th>
              <th className={css.heldNum}>Billed cost</th>
            </tr>
          </thead>
          <tbody>
            {receipt.delivery.lines.map((line) => {
              const item = itemByProduct.get(line.productId);
              const units = heldLineUnits(line);
              return (
                <tr key={line.productId}>
                  <td>
                    {item ? `${item.product.sku} — ${item.product.name}` : "Product"}
                    <span className={css.heldLineMeta}>
                      Batch {line.batchNo}
                      {line.freeQty ? ` · ${line.freeQty} free` : ""}
                      {line.rejectedQty ? ` · ${line.rejectedQty} damaged` : ""}
                      {` · Expiry ${line.expiryDate.slice(0, 10)}`}
                    </span>
                  </td>
                  <td className={css.heldNum}>{item?.outstandingQty ?? 0}</td>
                  <td className={`${css.heldNum}${units > (item?.outstandingQty ?? 0) ? ` ${css.heldFlag}` : ""}`}>
                    {units}
                  </td>
                  <td className={css.heldNum}>
                    {line.costPrice != null ? formatMoney(Number(line.costPrice)) : "Order cost"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ApprovalEvidencePanel
        approvedVersion={approved ? receipt.approvalVersion : null}
        currentVersion={receipt.approvalVersion}
        status={receipt.status === "approved" ? "approved" : receipt.status === "posted" ? "completed" : "pending"}
        statusLabel={STATUS_LABEL[receipt.status]}
        requester={{ name: receipt.preparedBy.fullName ?? "A colleague", at: receipt.preparedAt }}
        approver={receipt.approvedBy ? { name: receipt.approvedBy.fullName ?? "An approver", at: receipt.approvedAt } : null}
        executor={receipt.executedBy ? { name: receipt.executedBy.fullName ?? "Receiving", at: receipt.executedAt } : null}
      />

      {approved && counterOnly ? (
        <CounterHandoff branchName={branchName} action="Receive the goods" whoCan={["Inventory clerk", "Manager"]} />
      ) : null}
    </section>
  );
}
