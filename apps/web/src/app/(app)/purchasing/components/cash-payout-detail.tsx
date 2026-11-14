"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { SupplierCashPayoutView } from "@pharmaceylon/shared";
import { Alert } from "@/components/alert";
import {
  ActionButton,
  ApprovalEvidencePanel,
  CounterHandoff,
  StatusBadge,
} from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import { ConfirmDialog } from "../../products/components/confirm-dialog";
import { useInvoices } from "../hooks/use-ledger";
import { usePurchasingAccess } from "../hooks/use-purchasing-access";
import { formatDate, formatMoney } from "../utils";
import css from "../purchasing.module.css";

const STATUS_LABEL: Record<SupplierCashPayoutView["status"], string> = {
  prepared: "Awaiting approval",
  approved: "Approved — waiting at the counter",
  executed: "Executed",
  cancelled: "Cancelled",
};

type Props = {
  payout: SupplierCashPayoutView;
  branchName: string;
  invoiceNumbers: Map<string, string>;
  onChanged: () => void | Promise<void>;
};

export function CashPayoutDetail({ payout, branchName, invoiceNumbers, onChanged }: Props) {
  const access = usePurchasingAccess();
  const [intent, setIntent] = useState<"approve" | "cancel" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const approvalIdRef = useRef<string | null>(null);
  useEffect(() => {
    approvalIdRef.current = null;
  }, [payout.id, payout.approvalVersion]);
  const open = payout.status === "prepared" || payout.status === "approved";
  const showApprove = access.canPay && payout.status === "prepared" && !!payout.approvalReview;
  const showCancel = access.canPay && open;

  const invoices = useInvoices(
    { supplierId: payout.supplier?.id, status: "outstanding" },
    !!payout.supplier?.id,
  );
  const joinedAllocations = useMemo(
    () =>
      payout.allocations.map((part) => ({
        ...part,
        invoiceNumber:
          invoiceNumbers.get(part.invoiceId) ??
          invoices.rows.find((row) => row.id === part.invoiceId)?.invoiceNumber ??
          part.invoiceId.slice(0, 8),
      })),
    [payout.allocations, invoiceNumbers, invoices.rows],
  );

  async function confirm() {
    if (!intent) return;
    setBusy(true);
    setError(null);
    try {
      if (intent === "approve") {
        if (!payout.approvalReview) return;
        if (!approvalIdRef.current) approvalIdRef.current = crypto.randomUUID();
        await apiJson(`/purchasing/cash-payouts/${payout.id}/approve`, {
          method: "POST",
          body: JSON.stringify({
            approvalId: approvalIdRef.current,
            ...payout.approvalReview,
          }),
        });
      } else {
        await apiJson(`/purchasing/cash-payouts/${payout.id}/cancel`, { method: "POST" });
      }
      setIntent(null);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={css.sideCard} aria-label={`Payout ${payout.payoutNumber}`}>
      <ConfirmDialog
        open={intent !== null}
        title={intent === "approve" ? "Approve this cash payout?" : "Cancel this cash payout?"}
        variant={intent === "cancel" ? "danger" : "primary"}
        confirmLabel={intent === "approve" ? "Approve payout" : "Cancel payout"}
        loading={busy}
        onCancel={() => !busy && setIntent(null)}
        onConfirm={() => void confirm()}
      >
        {intent === "approve" ? (
          <p>
            Approval pins the supplier, amount, allocations and references for paying out at{" "}
            {branchName}. Money only leaves the drawer when someone pays it out at the counter.
          </p>
        ) : (
          <p>Cancel only while the payout is still waiting. Nothing moves at the counter.</p>
        )}
      </ConfirmDialog>

      <div className={css.heldBannerHead}>
        <div>
          <h3 className={css.heldBannerTitle}>{payout.payoutNumber}</h3>
          <p className={css.heldBannerMeta}>{payout.supplier?.name ?? "Supplier"}</p>
        </div>
        <StatusBadge status={payout.status} label={STATUS_LABEL[payout.status]} />
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      {payout.status === "approved" && payout.readyAtCounter && (
        <Alert variant="success">
          <b>Approved — pay this at the counter</b>
          This payout is on the Cash &amp; shift &ldquo;Pay out&rdquo; list at {branchName}. The
          browser cannot execute it (terminal only). Prepare bank or card payments on the ordinary
          payment path instead.
        </Alert>
      )}

      <div className={css.summaryGrid}>
        <div className={css.summaryRow}>
          <span>Amount</span>
          <span className={css.summaryValue}>{formatMoney(payout.amount)}</span>
        </div>
        <div className={css.summaryRow}>
          <span>Paid on</span>
          <span className={css.summaryValue}>{formatDate(payout.paidOn)}</span>
        </div>
        {payout.purchaseOrder && (
          <div className={css.summaryRow}>
            <span>PO</span>
            <span className={css.summaryValue}>{payout.purchaseOrder.poNumber}</span>
          </div>
        )}
        {payout.reference && (
          <div className={css.summaryRow}>
            <span>Reference</span>
            <span className={css.summaryValue}>{payout.reference}</span>
          </div>
        )}
      </div>

      {joinedAllocations.length > 0 && (
        <table className={css.heldTable}>
          <thead>
            <tr>
              <th>Invoice</th>
              <th className={css.heldNum}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {joinedAllocations.map((row) => (
              <tr key={row.invoiceId}>
                <td>{row.invoiceNumber}</td>
                <td className={css.heldNum}>{formatMoney(row.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {payout.notes && <p className={css.fieldHint}>{payout.notes}</p>}

      <ApprovalEvidencePanel
        approvedVersion={payout.approver ? payout.approvalVersion : null}
        currentVersion={payout.approvalVersion}
        status={payout.status}
        statusLabel={STATUS_LABEL[payout.status]}
        requester={
          payout.requester ? { name: payout.requester.fullName, at: payout.requestedAt } : null
        }
        approver={payout.approver ? { name: payout.approver.fullName, at: payout.approvedAt } : null}
        executor={payout.executor ? { name: payout.executor.fullName, at: payout.executedAt } : null}
      />

      {payout.status === "approved" && (
        <CounterHandoff
          branchName={branchName}
          variant="approved"
          action="Pay out from the drawer"
          whoCan={["suppliers.pay"]}
        />
      )}

      <div className={css.heldBannerActions}>
        {showCancel && (
          <ActionButton variant="danger" onClick={() => setIntent("cancel")} disabled={busy}>
            Cancel
          </ActionButton>
        )}
        {showApprove && (
          <ActionButton variant="primary" onClick={() => setIntent("approve")} disabled={busy}>
            Approve
          </ActionButton>
        )}
        {payout.status === "approved" && (
          <ActionButton variant="secondary" disabled title="Waiting at the counter">
            Waiting at the counter
          </ActionButton>
        )}
      </div>
    </section>
  );
}