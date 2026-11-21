"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { TransferShortCloseReason } from "@pharmaceylon/shared";
import { Alert } from "@/components/alert";
import { CounterMismatchNotes } from "@/components/counter-mismatch-notes";
import {
  ApprovalEvidencePanel,
  CounterHandoff,
  Modal,
  ModalButton,
  ModalFooter,
  StatusBadge,
} from "@/components/ui";
import type { AuthUser } from "@/lib/auth-types";
import { apiJson } from "@/lib/auth-client";
import { useBranchRollout } from "@/lib/branch-rollout";
import { createIdempotencyKey } from "@/lib/idempotency";
import { usePermissions } from "@/lib/permissions";
import layoutCss from "../../purchasing/purchasing.module.css";
import type { TransferListItem } from "../types";
import {
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
  needsApproval,
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
  const [closeMode, setCloseMode] = useState(false);
  const [closeReason, setCloseReason] = useState<TransferShortCloseReason>("lost_in_transit");
  const [closeNote, setCloseNote] = useState("");
  const idempotencyKeys = useRef<Record<string, string>>({});
  const atSource = !!branchId && transfer?.fromBranchId === branchId;
  const canApproveRole = canApproveTransfer(user, branchId);
  const { canSelfApprove } = usePermissions();
  const { rollout } = useBranchRollout();
  // Dispatch and receipt are physical: only a branch still selling from the web may do them
  // here. Live, fallback or not-yet-known branches hand them to the counter (D10, D-W2).
  const physicalOnWeb = rollout?.state === "not_live";
  const approvalIds = useRef<Record<string, string>>({});

  useEffect(() => {
    setBusy(false);
    setActionError(null);
    setReceiveMode(false);
    setCloseMode(false);
    setCloseReason("lost_in_transit");
    setCloseNote("");
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
      (sum, line) => sum + Math.max(0, line.qty - (line.receivedQty ?? 0) - (line.closedQty ?? 0)),
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
    canWrite && atSource && canApproveRole && needsApproval(transfer) && !!transfer.approvalReview;
  // Their role holds the approve permission, but not for their own requests. Say so on the
  // button rather than letting them click it and read a refusal afterwards.
  const ownRequestBlocked = !canSelfApprove && transfer.requestedBy === user?.id;
  const showReject =
    canWrite && atSource && canApproveRole && canReject(transfer.status);
  const showCancel =
    canWrite &&
    canCancel(transfer.status) &&
    canCancelTransfer(user, transfer, branchId);
  const readyToShip =
    !!branchId &&
    canShip(transfer.status, transfer.fromBranchId, branchId) &&
    !needsApproval(transfer);
  const awaitingHere =
    !!branchId && canReceive(transfer.status, transfer.toBranchId, branchId);
  const showShip = canWrite && readyToShip && physicalOnWeb;
  const showReceive = canWrite && awaitingHere && physicalOnWeb;
  // Decision 2: a manager at either branch closes what is still on the way, on the web.
  const atDestination = !!branchId && transfer.toBranchId === branchId;
  const onTheWay = transfer.status === "in_transit" || transfer.status === "partially_received";
  const showCloseShort =
    canWrite && canApproveRole && onTheWay && (atSource || atDestination) && remainingTotal > 0;
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

  // Pins the dispatch the screen shows; a different one is refused (409).
  const dispatchPin = { dispatchApprovalId: transfer.executionApprovalId ?? null };

  async function submitApprove() {
    const review = transfer!.approvalReview;
    if (!review) return;
    // One approval ID per displayed version, so a retried click can't approve twice.
    const slot = `${transfer!.id}:${review.expectedDigest}`;
    approvalIds.current[slot] ??= crypto.randomUUID();
    await runAction("approve", { approvalId: approvalIds.current[slot], ...review });
  }

  async function submitReceive(allRemaining: boolean) {
    const idem = mutationKey("receive");
    if (allRemaining) {
      if (await runAction("receive", dispatchPin, idem.key)) {
        delete idempotencyKeys.current[idem.slot];
      }
      return;
    }

    const lines = transfer!.items
      .map((line) => {
        const qty = Number(receiveQtys[line.id] ?? 0);
        // What this screen showed as already received; a stale count is refused (409).
        return { transferItemId: line.id, qty, receivedQtyBefore: line.receivedQty ?? 0 };
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

    if (await runAction("receive", { ...dispatchPin, lines }, idem.key)) {
      delete idempotencyKeys.current[idem.slot];
    }
  }

  async function submitCloseShort() {
    const note = closeNote.trim();
    if (note.length < 3) {
      setActionError("Say what happened to the rest");
      return;
    }
    // Pins what this screen showed still on the way; anything received since is refused (409).
    const remaining = transfer!.items
      .map((line) => ({
        transferItemId: line.id,
        qty: line.qty - (line.receivedQty ?? 0) - (line.closedQty ?? 0),
      }))
      .filter((line) => line.qty > 0);
    await runAction("close-short", { reason: closeReason, note, remaining });
  }

  async function submitShip() {
    const idem = mutationKey("ship");
    // Pins the approval the dispatcher saw (null only when approval is waived).
    if (await runAction("ship", { approvalId: transfer!.executionApprovalId ?? null }, idem.key)) {
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
          {closeMode ? (
            <>
              <ModalButton
                variant="secondary"
                onClick={() => {
                  setCloseMode(false);
                  setActionError(null);
                }}
                disabled={busy}
              >
                Back
              </ModalButton>
              <ModalButton
                variant="danger"
                onClick={() => void submitCloseShort()}
                loading={busy}
                disabled={busy || closeNote.trim().length < 3}
              >
                Close the rest ({remainingTotal} units)
              </ModalButton>
            </>
          ) : receiveMode ? (
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
                    onClick={() => void submitApprove()}
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
              {showCloseShort && (
                <ModalButton
                  variant="secondary"
                  onClick={() => {
                    setActionError(null);
                    setCloseReason(atSource ? closeReason : "lost_in_transit");
                    setCloseMode(true);
                  }}
                  disabled={busy}
                >
                  Close the rest
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

      {canWrite && readyToShip && !physicalOnWeb ? (
        <CounterHandoff
          branchName={transfer.fromBranch.name}
          action="Dispatch the goods"
          whoCan={["Inventory clerk", "Manager"]}
        />
      ) : null}

      {canWrite && awaitingHere && !physicalOnWeb ? (
        <CounterHandoff
          branchName={transfer.toBranch.name}
          action="Count and receive the goods"
          whoCan={["Inventory clerk", "Manager"]}
        />
      ) : null}

      {atSource && transfer.status === "approved" ? (
        <CounterMismatchNotes
          kind="transfer_ship"
          documentId={transfer.id}
          canAnswer={canWrite && canApproveRole}
          onAnswered={onChanged}
        />
      ) : null}
      {atDestination && onTheWay ? (
        <CounterMismatchNotes
          kind="transfer_receive"
          documentId={transfer.id}
          canAnswer={canWrite && canApproveRole}
          onAnswered={onChanged}
        />
      ) : null}

      {transfer.shortClosedAt ? (
        <Alert variant="info" className={layoutCss.modalAlert}>
          {transfer.closedQty ?? 0} units were closed short on {formatDate(transfer.shortClosedAt)}:{" "}
          {transfer.shortCloseReason === "never_left_source"
            ? `they never left ${transfer.fromBranch.name} and went back into its stock`
            : "lost in transit and written off"}
          {transfer.shortCloseNote ? <> &mdash; &ldquo;{transfer.shortCloseNote}&rdquo;</> : null}
        </Alert>
      ) : null}

      {closeMode ? (
        <div className={tcss.notesBlock}>
          <p style={{ marginTop: 0 }}>
            <strong>Close the {remainingTotal} units still on the way.</strong> Nothing more can be received on
            this transfer afterwards.
          </p>
          <label style={{ display: "block", marginBottom: "0.35rem" }}>
            <input
              type="radio"
              name="close-reason"
              checked={closeReason === "lost_in_transit"}
              onChange={() => setCloseReason("lost_in_transit")}
              disabled={busy}
            />{" "}
            Lost in transit: write them off as lost at {transfer.fromBranch.name}
          </label>
          <label
            style={{ display: "block", marginBottom: "0.6rem" }}
            data-tooltip={atSource ? undefined : `Only ${transfer.fromBranch.name} can say this`}
          >
            <input
              type="radio"
              name="close-reason"
              checked={closeReason === "never_left_source"}
              onChange={() => setCloseReason("never_left_source")}
              disabled={busy || !atSource}
            />{" "}
            They never left {transfer.fromBranch.name}: put them back into its stock
          </label>
          <textarea
            className={layoutCss.textarea}
            rows={2}
            maxLength={500}
            placeholder="What happened to them"
            value={closeNote}
            onChange={(e) => setCloseNote(e.target.value)}
            disabled={busy}
            aria-label="Why the rest is being closed"
          />
        </div>
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
          <span className={tcss.detailLabel}>In transit</span>
          <span className={tcss.detailValue}>{transfer.inTransitQty ?? 0} units</span>
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

      <ApprovalEvidencePanel
        title="Approval and dispatch"
        approvedVersion={transfer.approvedVersion ?? null}
        currentVersion={transfer.approvalVersion ?? null}
        status={displayStatus}
        requester={{ name: transfer.requester.fullName, at: transfer.createdAt }}
        approver={
          transfer.approvalWaived
            ? { name: "Not required (Approval Rules)" }
            : transfer.approver && transfer.status !== "requested" && transfer.status !== "rejected"
              ? { name: transfer.approver.fullName, at: transfer.approvedAt ?? null }
              : null
        }
        executor={
          transfer.dispatcher
            ? { name: transfer.dispatcher.fullName, at: transfer.dispatchedAt ?? null }
            : null
        }
      />

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
            const remaining = Math.max(0, line.qty - (line.receivedQty ?? 0) - (line.closedQty ?? 0));
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
