"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { Modal, ModalButton, ModalFooter, StatusBadge } from "@/components/ui";
import type { AuthUser } from "@/lib/auth-types";
import { apiJson } from "@/lib/auth-client";
import { usePermissions } from "@/lib/permissions";
import layoutCss from "../../purchasing/purchasing.module.css";
import type { ReturnListItem } from "../types";
import {
  canApprove,
  canApproveReturn,
  canCancel,
  canCancelReturn,
  canComplete,
  canMarkLogistics,
  canReject,
  canSubmit,
  displayStatus,
  displayStatusLabel,
  formatDate,
  formatMoney,
  formatReturnNo,
  hasReturnWriteAccess,
  returnLineCount,
  returnPartyLabel,
} from "../utils";
import rcss from "../returns.module.css";

type Props = {
  returnItem: ReturnListItem | null;
  branchId: string | null;
  user: AuthUser | null;
  onClose: () => void;
  onChanged: () => void;
};

export function ReturnDetailModal({
  returnItem,
  branchId,
  user,
  onClose,
  onChanged,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const { permissionKeys } = usePermissions();

  useEffect(() => {
    setBusy(false);
    setActionError(null);
  }, [returnItem]);

  if (!returnItem) return null;

  const canWrite = hasReturnWriteAccess(user, branchId);
  const canApproveRole = canApproveReturn(permissionKeys);
  const atBranch = !!branchId && returnItem.branchId === branchId;

  const showSubmit = canWrite && atBranch && canSubmit(returnItem.status);
  const showApprove =
    canWrite && atBranch && canApproveRole && canApprove(returnItem.status);
  const showReject =
    canWrite && atBranch && canApproveRole && canReject(returnItem.status);
  const showMarkLogistics =
    canWrite && atBranch && canMarkLogistics(returnItem.status);
  const showComplete = canWrite && atBranch && canComplete(returnItem.status);
  const showCancel =
    canWrite &&
    canCancel(returnItem.status) &&
    canCancelReturn(user, returnItem, branchId, permissionKeys);

  const logisticsLabel =
    returnItem.type === "customer" ? "Mark pickup" : "Mark dispatch";

  async function runAction(path: string) {
    setBusy(true);
    setActionError(null);
    try {
      await apiJson(`/returns/${returnItem!.id}/${path}`, {
        method: "POST",
      });
      onChanged();
      onClose();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={!!returnItem}
      onClose={onClose}
      title={formatReturnNo(returnItem)}
      description={`${returnItem.type === "customer" ? "Customer" : "Supplier"} return · ${returnPartyLabel(returnItem)}`}
      size="lg"
      canDismiss={!busy}
      footer={
        <ModalFooter className={layoutCss.detailFooter}>
          <ModalButton variant="secondary" onClick={onClose} disabled={busy}>
            Close
          </ModalButton>
          {showCancel && (
            <ModalButton
              variant="danger"
              onClick={() => void runAction("cancel")}
              disabled={busy}
            >
              Cancel
            </ModalButton>
          )}
          {showReject && (
            <ModalButton
              variant="danger"
              onClick={() => void runAction("reject")}
              disabled={busy}
            >
              Reject
            </ModalButton>
          )}
          {showSubmit && (
            <ModalButton
              variant="secondary"
              onClick={() => void runAction("submit")}
              disabled={busy}
            >
              Submit
            </ModalButton>
          )}
          {showMarkLogistics && (
            <ModalButton
              variant="secondary"
              onClick={() => void runAction("mark-logistics")}
              disabled={busy}
            >
              {logisticsLabel}
            </ModalButton>
          )}
          {showApprove && (
            <ModalButton
              variant="primary"
              onClick={() => void runAction("approve")}
              disabled={busy}
            >
              Approve
            </ModalButton>
          )}
          {showComplete && (
            <ModalButton
              variant="primary"
              onClick={() => void runAction("complete")}
              disabled={busy}
            >
              Complete
            </ModalButton>
          )}
        </ModalFooter>
      }
    >
      {actionError ? <Alert variant="error">{actionError}</Alert> : null}

      {!atBranch && branchId ? (
        <Alert variant="warning" className={layoutCss.modalAlert}>
          Switch to the return&apos;s branch to perform workflow actions.
        </Alert>
      ) : null}

      <div className={rcss.detailGrid}>
        <div className={rcss.detailField}>
          <span className={rcss.detailLabel}>Status</span>
          <span className={rcss.detailValue}>
            <StatusBadge
              status={displayStatus(returnItem)}
              label={displayStatusLabel(returnItem.status, returnItem.type)}
            />
          </span>
        </div>
        <div className={rcss.detailField}>
          <span className={rcss.detailLabel}>Type</span>
          <span className={rcss.detailValue}>
            <span
              className={`${rcss.typeTag} ${
                returnItem.type === "customer"
                  ? rcss.typeTagCustomer
                  : rcss.typeTagSupplier
              }`}
            >
              {returnItem.type === "customer" ? "Customer" : "Supplier"}
            </span>
          </span>
        </div>
        <div className={rcss.detailField}>
          <span className={rcss.detailLabel}>
            {returnItem.type === "customer" ? "Customer" : "Supplier"}
          </span>
          <span className={rcss.detailValue}>{returnPartyLabel(returnItem)}</span>
        </div>
        <div className={rcss.detailField}>
          <span className={rcss.detailLabel}>Amount</span>
          <span className={rcss.detailValue}>{formatMoney(returnItem.amount)}</span>
        </div>
        <div className={rcss.detailField}>
          <span className={rcss.detailLabel}>Requested</span>
          <span className={rcss.detailValue}>
            {formatDate(returnItem.createdAt)} · {returnItem.requester.fullName}
          </span>
        </div>
        <div className={rcss.detailField}>
          <span className={rcss.detailLabel}>Updated</span>
          <span className={rcss.detailValue}>{formatDate(returnItem.updatedAt)}</span>
        </div>
        <div className={rcss.detailField}>
          <span className={rcss.detailLabel}>Approved by</span>
          <span className={rcss.detailValue}>
            {returnItem.approver?.fullName ?? "—"}
          </span>
        </div>
        <div className={rcss.detailField}>
          <span className={rcss.detailLabel}>Processed by</span>
          <span className={rcss.detailValue}>
            {returnItem.processor?.fullName ?? "—"}
          </span>
        </div>
        {returnItem.sale?.invoiceNo ? (
          <div className={rcss.detailField}>
            <span className={rcss.detailLabel}>Sale invoice</span>
            <span className={rcss.detailValue}>{returnItem.sale.invoiceNo}</span>
          </div>
        ) : null}
        {returnItem.purchaseOrder?.poNumber ? (
          <div className={rcss.detailField}>
            <span className={rcss.detailLabel}>Purchase order</span>
            <span className={rcss.detailValue}>{returnItem.purchaseOrder.poNumber}</span>
          </div>
        ) : null}
        {returnItem.goodsReceipt?.grnNumber ? (
          <div className={rcss.detailField}>
            <span className={rcss.detailLabel}>Goods receipt</span>
            <span className={rcss.detailValue}>{returnItem.goodsReceipt.grnNumber}</span>
          </div>
        ) : null}
        <div className={rcss.detailField}>
          <span className={rcss.detailLabel}>Items / qty</span>
          <span className={rcss.detailValue}>
            {returnItem.items.length} item
            {returnItem.items.length === 1 ? "" : "s"} ·{" "}
            {returnLineCount(returnItem.items)} units
          </span>
        </div>
      </div>

      {returnItem.reason ? (
        <p className={rcss.notesBlock}>
          <span className={rcss.notesLabel}>Reason</span>
          {returnItem.reason}
        </p>
      ) : null}

      {returnItem.notes ? (
        <p className={rcss.notesBlock}>
          <span className={rcss.notesLabel}>Notes</span>
          {returnItem.notes}
        </p>
      ) : null}

      <table className={rcss.linesTable}>
        <thead>
          <tr>
            <th>Product</th>
            <th>Batch</th>
            <th>Qty</th>
            <th>Unit price</th>
            <th>Line total</th>
          </tr>
        </thead>
        <tbody>
          {returnItem.items.map((line) => {
            const unit = Number(line.unitPrice);
            const lineTotal = line.qty * (Number.isFinite(unit) ? unit : 0);
            return (
              <tr key={line.id}>
                <td>
                  <span className={rcss.lineSku}>{line.product.sku}</span>
                  {" — "}
                  {line.product.name}
                </td>
                <td>{line.batch?.batchNo ?? "—"}</td>
                <td>{line.qty}</td>
                <td>{formatMoney(line.unitPrice)}</td>
                <td>{formatMoney(lineTotal)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Modal>
  );
}
