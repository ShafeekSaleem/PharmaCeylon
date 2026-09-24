"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "@/components/alert";
import { Modal, ModalButton, ModalFooter, StatusBadge } from "@/components/ui";
import type { AuthUser } from "@/lib/auth-types";
import { apiJson } from "@/lib/auth-client";
import { createIdempotencyKey } from "@/lib/idempotency";
import { usePermissions } from "@/lib/permissions";
import layoutCss from "../../purchasing/purchasing.module.css";
import type { TransferListItem } from "../types";
import {
  canApprove,
  canApproveTransfer,
  canCancel,
  canCancelTransfer,
  canReceive,
  canReject,
  canShip,
  displayTransferStatus,
  formatDate,
  formatTransferNo,
  needsDestinationBranchToReceive,
  needsSourceBranchForSourceActions,
  receivedPercent,
  transferLineCount,
} from "../utils";
import tcss from "../transfers.module.css";

type Props = {
  transfer: TransferListItem | null;
  branchId: string | null;
  canWrite: boolean;
  user: AuthUser | null;
  onClose: () => void;
  onChanged: () => void;
};

export function TransferDetailModal({
  transfer,
  branchId,
  canWrite,
  user,
  onClose,
  onChanged,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [receiveMode, setReceiveMode] = useState(false);
  const [receiveQtys, setReceiveQtys] = useState<Record<string, string>>({});
  const idempotencyKeys = useRef<Record<string, string>>({});
  const atSource = !!branchId && transfer?.fromBranchId === branchId;
  const canApproveRole = canApproveTransfer(user, branchId);
  const { canSelfApprove } = usePermissions();

  useEffect(() => {
    setBusy(false);
    setActionError(null);
    setReceiveMode(false);
    if (!transfer) {
      setReceiveQtys({});
      return;
    }
    const next: Record<string, string> = {};
    for (const line of transfer.items) {
      next[line.id] = "0";
    }
    setReceiveQtys(next);
  }, [transfer]);

  const remainingTotal = useMemo(() => {
    if (!transfer) return 0;
    return transfer.items.reduce(
      (sum, line) => sum + Math.max(0, line.qty - (line.receivedQty ?? 0)),
      0,
    );
  }, [transfer]);

  const partialQtyTotal = useMemo(() => {
    if (!transfer) return 0;
    return transfer.items.reduce((sum, line) => {
      const qty = Number(receiveQtys[line.id] ?? 0);
      return sum + (Number.isInteger(qty) && qty > 0 ? qty : 0);
    }, 0);
  }, [transfer, receiveQtys]);

  if (!transfer) return null;

  const pct = receivedPercent(transfer);
  const displayStatus = displayTransferStatus(transfer);
  const showApprove =
    canWrite && atSource && canApproveRole && canApprove(transfer.status);
  // Their role holds the approve permission, but not for their own requests. Say so on the
  // button rather than letting them click it and read a refusal afterwards.
  const ownRequestBlocked = !canSelfApprove && transfer.requestedBy === user?.id;
  const showReject =
    canWrite && atSource && canApproveRole && canReject(transfer.status);
  const showCancel =
    canWrite &&
    canCancel(transfer.status) &&
    canCancelTransfer(user, transfer, branchId);
  const showShip =
    canWrite && branchId && canShip(transfer.status, transfer.fromBranchId, branchId);
  const showReceive =
    canWrite && branchId && canReceive(transfer.status, transfer.toBranchId, branchId);
  const needsSourceBranch =
    canWrite &&
    needsSourceBranchForSourceActions(transfer.status, transfer.fromBranchId, branchId);
  const needsDestinationBranch =
    canWrite &&
    needsDestinationBranchToReceive(transfer.status, transfer.toBranchId, branchId);

  function mutationKey(action: "ship" | "receive") {
    const slot = `${action}:${transfer!.id}`;
    idempotencyKeys.current[slot] ??= createIdempotencyKey(action, transfer!.id);
    return { slot, key: idempotencyKeys.current[slot] };
  }

  async function runAction(
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<boolean> {
    setBusy(true);
    setActionError(null);
    try {
      const headers: Record<string, string> = {};
      if (body) headers["Content-Type"] = "application/json";
      if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

      await apiJson(`/transfers/${transfer!.id}/${path}`, {
        method: "POST",
        headers: Object.keys(headers).length ? headers : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      onChanged();
      onClose();
      return true;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Action failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submitReceive(allRemaining: boolean) {
    const idem = mutationKey("receive");
    if (allRemaining) {
      if (await runAction("receive", {}, idem.key)) {
        delete idempotencyKeys.current[idem.slot];
      }
      return;
    }

    const lines = transfer!.items
      .map((line) => {
        const qty = Number(receiveQtys[line.id] ?? 0);
        return { transferItemId: line.id, qty };
      })
      .filter((line) => Number.isInteger(line.qty) && line.qty > 0);

    if (lines.length === 0) {
      setActionError("Enter at least one quantity to receive");
      return;
    }

    for (const line of lines) {
      const item = transfer!.items.find((i) => i.id === line.transferItemId);
      if (!item) continue;
      const remaining = item.qty - (item.receivedQty ?? 0);
      if (line.qty > remaining) {
        setActionError(
          `Cannot receive ${line.qty} of ${item.product.sku}; only ${remaining} remaining`,
        );
        return;
      }
    }

    if (await runAction("receive", { lines }, idem.key)) {
      delete idempotencyKeys.current[idem.slot];
    }
  }

  async function submitShip() {
    const idem = mutationKey("ship");
    if (await runAction("ship", undefined, idem.key)) {
      delete idempotencyKeys.current[idem.slot];
    }
  }

  return (
    <Modal
      open={!!transfer}
      onClose={onClose}
      title={formatTransferNo(transfer)}
      description={`${transfer.fromBranch.name} → ${transfer.toBranch.name}`}
      size="lg"
      canDismiss={!busy}
      footer={
        <ModalFooter className={layoutCss.detailFooter}>
          {receiveMode ? (
            <>
              <ModalButton
                variant="secondary"
                onClick={() => {
                  setReceiveMode(false);
                  setActionError(null);
                }}
                disabled={busy}
              >
                Back
              </ModalButton>
              <ModalButton
                variant="primary"
                onClick={() => void submitReceive(false)}
                loading={busy}
                disabled={busy || partialQtyTotal === 0}
              >
                Confirm partial receive
              </ModalButton>
            </>
          ) : (
            <>
              <ModalButton variant="secondary" onClick={onClose} disabled={busy}>
                Close
              </ModalButton>
              {showCancel && (
                <ModalButton
                  variant="danger"
                  onClick={() => void runAction("cancel")}
                  disabled={busy}
                >
                  Cancel transfer
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
              {showApprove && (
                <span
                  data-tooltip={
                    ownRequestBlocked
                      ? "You raised this transfer, and your role can't approve its own requests. Ask another approver."
                      : undefined
                  }
                >
                  <ModalButton
                    variant="primary"
                    onClick={() => void runAction("approve")}
                    disabled={busy || ownRequestBlocked}
                  >
                    Approve
                  </ModalButton>
                </span>
              )}
              {showShip && (
                <ModalButton
                  variant="secondary"
                  onClick={() => void submitShip()}
                  disabled={busy}
                >
                  Ship / dispatch
                </ModalButton>
              )}
              {showReceive && (
                <>
                  <ModalButton
                    variant="secondary"
                    onClick={() => {
                      setActionError(null);
                      setReceiveMode(true);
                    }}
                    disabled={busy || remainingTotal === 0}
                  >
                    Partial receive
                  </ModalButton>
                  <ModalButton
                    variant="primary"
                    onClick={() => void submitReceive(true)}
                    disabled={busy || remainingTotal === 0}
                  >
                    Receive all remaining
                  </ModalButton>
                </>
              )}
            </>
          )}
        </ModalFooter>
      }
    >
      {actionError ? <Alert variant="error">{actionError}</Alert> : null}

      {needsSourceBranch ? (
        <Alert variant="warning" className={layoutCss.modalAlert}>
          Switch the active branch to <strong>{transfer.fromBranch.name}</strong> to
          approve, reject, cancel, or ship this transfer.
        </Alert>
      ) : null}

      {needsDestinationBranch ? (
        <Alert variant="warning" className={layoutCss.modalAlert}>
          Switch the active branch to <strong>{transfer.toBranch.name}</strong> to
          receive this transfer (partial or full).
        </Alert>
      ) : null}

      {receiveMode ? (
        <Alert variant="info" className={layoutCss.modalAlert}>
          Enter how many units arrived now for each line. Stock posts to{" "}
          <strong>{transfer.toBranch.name}</strong>. Leave a line at 0 to keep it in transit.
        </Alert>
      ) : null}

      <div className={tcss.detailGrid}>
        <div className={tcss.detailField}>
          <span className={tcss.detailLabel}>Status</span>
          <span className={tcss.detailValue}>
            <StatusBadge status={displayStatus} />
          </span>
        </div>
        <div className={tcss.detailField}>
          <span className={tcss.detailLabel}>Received</span>
          <span className={tcss.detailValue}>
            {transfer.receivedQty ?? 0} / {transfer.totalQty ?? transferLineCount(transfer.items)}{" "}
            units ({pct}%)
          </span>
        </div>
        <div className={tcss.detailField}>
          <span className={tcss.detailLabel}>Requested</span>
          <span className={tcss.detailValue}>{formatDate(transfer.createdAt)}</span>
        </div>
        <div className={tcss.detailField}>
          <span className={tcss.detailLabel}>Expected delivery</span>
          <span className={tcss.detailValue}>{formatDate(transfer.expectedOn)}</span>
        </div>
        <div className={tcss.detailField}>
          <span className={tcss.detailLabel}>Created by</span>
          <span className={tcss.detailValue}>{transfer.requester.fullName}</span>
        </div>
        <div className={tcss.detailField}>
          <span className={tcss.detailLabel}>Approved by</span>
          <span className={tcss.detailValue}>{transfer.approver?.fullName ?? "—"}</span>
        </div>
      </div>

      {transfer.notes ? (
        <p className={tcss.notesBlock}>
          <strong>Notes:</strong> {transfer.notes}
        </p>
      ) : null}

      <table className={tcss.linesTable}>
        <thead>
          <tr>
            <th>Product</th>
            <th>Batch</th>
            <th>Ordered</th>
            <th>Received</th>
            <th>Remaining</th>
            {receiveMode ? <th>Receive now</th> : null}
          </tr>
        </thead>
        <tbody>
          {transfer.items.map((line) => {
            const remaining = Math.max(0, line.qty - (line.receivedQty ?? 0));
            return (
              <tr key={line.id}>
                <td>
                  <span className={layoutCss.muted}>{line.product.sku}</span>
                  {" — "}
                  {line.product.name}
                </td>
                <td>{line.batch?.batchNo ?? "—"}</td>
                <td>{line.qty}</td>
                <td>{line.receivedQty ?? 0}</td>
                <td>{remaining}</td>
                {receiveMode ? (
                  <td style={{ width: 96 }}>
                    <input
                      type="number"
                      min={0}
                      max={remaining}
                      className={layoutCss.input}
                      value={receiveQtys[line.id] ?? "0"}
                      disabled={busy || remaining === 0}
                      onChange={(e) =>
                        setReceiveQtys((prev) => ({ ...prev, [line.id]: e.target.value }))
                      }
                      aria-label={`Receive qty for ${line.product.sku}`}
                    />
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </Modal>
  );
}
