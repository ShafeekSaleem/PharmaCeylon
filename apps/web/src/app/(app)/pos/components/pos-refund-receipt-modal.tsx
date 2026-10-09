"use client";

import { IconPrinter, IconRotateCcw } from "@/components/icons";
import { Modal, ModalButton, ModalFooter } from "@/components/ui";
import { PAYMENT_METHOD_LABELS } from "../constants";
import type { PaymentMethod } from "../types";
import { formatDate, formatMoney, formatTime } from "../utils";
import type { ReceiptPreferences } from "./pos-receipt-modal";
import css from "../pos.module.css";

export type RefundReceipt = {
  returnNumber: string;
  invoiceNo: string;
  at: string;
  customerName: string | null;
  lines: Array<{ name: string; batchNo: string; qty: number; amount: number; held: boolean }>;
  refundedTo: Array<{ method: PaymentMethod; amount: number }>;
  reason: string;
  note: string | null;
};

type Props = {
  receipt: RefundReceipt | null;
  onClose: () => void;
  preferences: ReceiptPreferences;
  organization: { displayName: string; logoUrl: string | null } | null;
};

/** The customer's copy of a refund — laid out like a sale receipt, printed the same way. */
export function PosRefundReceiptModal({ receipt, onClose, preferences, organization }: Props) {
  const total = receipt?.refundedTo.reduce((sum, p) => sum + p.amount, 0) ?? 0;
  return (
    <Modal
      open={receipt !== null}
      onClose={onClose}
      title="Refund receipt"
      size="md"
      footer={
        <ModalFooter>
          <ModalButton onClick={onClose}>Done</ModalButton>
          <ModalButton variant="primary" onClick={() => window.print()}>
            <IconPrinter size={14} /> Print
          </ModalButton>
        </ModalFooter>
      }
    >
      {receipt && (
        <div className={css.receiptBody} data-paper-size={preferences.paperSize}>
          {(preferences.showLogo && organization?.logoUrl) || preferences.headerText ? (
            <div className={css.receiptBrand}>
              {preferences.showLogo && organization?.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={organization.logoUrl} alt="" />
              ) : null}
              <strong>{preferences.headerText || organization?.displayName}</strong>
            </div>
          ) : null}
          <div className={css.receiptHead}>
            <span className={css.receiptBadge}>
              <IconRotateCcw size={20} />
            </span>
            <span className={css.productText}>
              <span className={css.receiptTitle}>Refund {receipt.returnNumber}</span>
              <span className={css.receiptSub}>
                {formatDate(receipt.at)} at {formatTime(receipt.at)} · sale {receipt.invoiceNo}
                {receipt.customerName ? ` · ${receipt.customerName}` : ""}
              </span>
            </span>
          </div>
          <table className={css.receiptTable}>
            <tbody>
              {receipt.lines.map((line, index) => (
                <tr key={`${line.name}-${index}`}>
                  <td>
                    {line.name} × {line.qty}
                    <div className={css.receiptSub}>
                      Batch {line.batchNo}
                      {line.held ? " · held for inspection" : ""}
                    </div>
                  </td>
                  <td className={css.colNum}>{formatMoney(line.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className={css.receiptTotals}>
            <div className={css.receiptGrand}>
              <span>Refunded</span>
              <span>{formatMoney(total)}</span>
            </div>
            {receipt.refundedTo.map((p) => (
              <div key={p.method} className={css.summaryRow}>
                <span className={css.summaryLabel}>To {PAYMENT_METHOD_LABELS[p.method]}</span>
                <span className={css.summaryValue}>{formatMoney(p.amount)}</span>
              </div>
            ))}
            <div className={css.summaryRow}>
              <span className={css.summaryLabel}>Reason</span>
              <span className={css.summaryValue}>
                {receipt.reason}
                {receipt.note ? ` — ${receipt.note}` : ""}
              </span>
            </div>
          </div>
          {preferences.footerText ? (
            <p className={css.receiptSub} style={{ marginTop: "0.5rem" }}>
              {preferences.footerText}
            </p>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
