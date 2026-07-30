"use client";

import { IconCheckCircle, IconPrinter } from "@/components/icons";
import { Modal, ModalButton, ModalFooter } from "@/components/ui";
import { PAYMENT_METHOD_LABELS } from "../constants";
import type { SaleReceipt } from "../types";
import { formatAmount, formatDate, formatMoney, formatTime } from "../utils";
import css from "../pos.module.css";

type Props = {
  receipt: SaleReceipt | null;
  onClose: () => void;
};

export function PosReceiptModal({ receipt, onClose }: Props) {
  return (
    <Modal
      open={receipt !== null}
      onClose={onClose}
      title="Receipt"
      size="md"
      footer={
        <ModalFooter>
          <ModalButton onClick={onClose}>Close</ModalButton>
          <ModalButton variant="primary" onClick={() => window.print()}>
            <IconPrinter size={14} /> Print
          </ModalButton>
        </ModalFooter>
      }
    >
      {receipt && (
        <>
          <div className={css.receiptHead}>
            <span className={css.receiptBadge}>
              <IconCheckCircle size={20} />
            </span>
            <span className={css.productText}>
              <span className={css.receiptTitle}>{receipt.invoiceNo}</span>
              <span className={css.receiptSub}>
                {formatDate(receipt.soldAt)} at {formatTime(receipt.soldAt)} ·{" "}
                {receipt.seller.fullName}
              </span>
            </span>
          </div>

          <p className={css.receiptSub} style={{ marginTop: "0.5rem" }}>
            {receipt.customer ? receipt.customer.fullName : "Walk-in customer"}
            {receipt.prescription
              ? ` · Rx ${receipt.prescription.rxNumber} (${receipt.prescription.patientName})`
              : ""}
          </p>

          <table className={css.receiptTable}>
            <thead>
              <tr>
                <th>Item</th>
                <th>Qty</th>
                <th style={{ textAlign: "right" }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {receipt.items.map((item) => (
                <tr key={item.id}>
                  <td>
                    {item.product.name}
                    <div className={css.receiptSub}>Batch {item.batch.batchNo}</div>
                  </td>
                  <td>{item.qty}</td>
                  <td style={{ textAlign: "right" }}>{formatAmount(item.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className={css.receiptTotals}>
            <div className={css.summaryRow}>
              <span className={css.summaryLabel}>Subtotal</span>
              <span className={css.summaryValue}>{formatMoney(receipt.subtotal)}</span>
            </div>
            <div className={css.summaryRow}>
              <span className={css.summaryLabel}>Discount</span>
              <span className={css.summaryValue}>- {formatMoney(receipt.discountTotal)}</span>
            </div>
            <div className={css.summaryRow}>
              <span className={css.summaryLabel}>VAT</span>
              <span className={css.summaryValue}>{formatMoney(receipt.taxTotal)}</span>
            </div>
            <div className={css.receiptGrand}>
              <span>Total</span>
              <span>{formatMoney(receipt.grandTotal)}</span>
            </div>
            {receipt.payments.map((payment) => (
              <div key={payment.id} className={css.summaryRow}>
                <span className={css.summaryLabel}>{PAYMENT_METHOD_LABELS[payment.method]}</span>
                <span className={css.summaryValue}>{formatMoney(payment.amount)}</span>
              </div>
            ))}
            <div className={css.summaryRow}>
              <span className={css.summaryLabel}>Change</span>
              <span className={css.summaryValue}>{formatMoney(receipt.changeDue)}</span>
            </div>
          </div>

          {receipt.notes && <p className={css.receiptSub}>Note: {receipt.notes}</p>}
        </>
      )}
    </Modal>
  );
}
