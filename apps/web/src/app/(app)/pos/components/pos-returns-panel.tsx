"use client";

import Link from "next/link";
import { useState } from "react";
import { IconRotateCcw, IconSearch } from "@/components/icons";
import { StatusBadge } from "@/components/ui";
import { findSaleByInvoice, refundSale } from "../services/pos-api";
import type { SaleReceipt } from "../types";
import { formatAmount, formatDate, formatMoney, formatTime } from "../utils";
import css from "../pos.module.css";

type Props = {
  canRefund: boolean;
  onRefunded: (sale: SaleReceipt) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
};

/**
 * Returns lane: find the original invoice, then refund it in full (stock goes
 * back to the same batches). Partial / supplier returns stay in the Returns
 * workspace, which this deep-links to.
 */
export function PosReturnsPanel({ canRefund, onRefunded, onError, onNotice }: Props) {
  const [invoiceNo, setInvoiceNo] = useState("");
  const [sale, setSale] = useState<SaleReceipt | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function find() {
    if (!invoiceNo.trim()) return;
    setBusy(true);
    try {
      setSale(await findSaleByInvoice(invoiceNo));
    } catch (e) {
      setSale(null);
      onError(e instanceof Error ? e.message : "Invoice not found");
    } finally {
      setBusy(false);
    }
  }

  async function refund() {
    if (!sale) return;
    if (!reason.trim()) {
      onError("Enter a reason for the refund");
      return;
    }
    setBusy(true);
    try {
      const refunded = await refundSale(sale.id, reason.trim());
      setSale(refunded);
      setReason("");
      onRefunded(refunded);
      onNotice(`Refunded ${refunded.invoiceNo} — stock returned to its original batches.`);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Refund failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`${css.card} ${css.returnsPanel}`}>
      <div className={css.returnsSearchRow}>
        <input
          className={css.control}
          placeholder="Invoice number, e.g. INV-2507-001120"
          value={invoiceNo}
          autoFocus
          onChange={(e) => setInvoiceNo(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void find();
          }}
        />
        <button type="button" className={css.toolBtn} onClick={() => void find()} disabled={busy}>
          <IconSearch size={15} />
          Find invoice
        </button>
        <Link href="/returns" className={css.toolBtn}>
          Partial &amp; supplier returns
        </Link>
      </div>

      {sale ? (
        <>
          <div className={css.returnsSummary}>
            <div className={css.returnsStat}>
              <span className={css.returnsStatLabel}>Invoice</span>
              <span className={css.returnsStatValue}>{sale.invoiceNo}</span>
            </div>
            <div className={css.returnsStat}>
              <span className={css.returnsStatLabel}>Sold</span>
              <span className={css.returnsStatValue}>
                {formatDate(sale.soldAt)} {formatTime(sale.soldAt)}
              </span>
            </div>
            <div className={css.returnsStat}>
              <span className={css.returnsStatLabel}>Customer</span>
              <span className={css.returnsStatValue}>
                {sale.customer?.fullName ?? "Walk-in"}
              </span>
            </div>
            <div className={css.returnsStat}>
              <span className={css.returnsStatLabel}>Total</span>
              <span className={css.returnsStatValue}>{formatMoney(sale.grandTotal)}</span>
            </div>
            <div className={css.returnsStat}>
              <span className={css.returnsStatLabel}>Status</span>
              <StatusBadge
                status={sale.status}
                variant={sale.status === "posted" ? "success" : "danger"}
                dot
              />
            </div>
          </div>

          <table className={css.cartTable}>
            <thead>
              <tr>
                <th>Product</th>
                <th>Batch</th>
                <th>Qty</th>
                <th className={css.colNum}>Line total</th>
              </tr>
            </thead>
            <tbody>
              {sale.items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <Link href={`/products/${item.product.id}`} className={css.productLink}>
                      {item.product.name}
                    </Link>
                  </td>
                  <td>{item.batch.batchNo}</td>
                  <td>{item.qty}</td>
                  <td className={css.colNum}>{formatAmount(item.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {sale.status === "posted" && (
            <div className={css.returnsActions}>
              <input
                className={css.control}
                style={{ flex: "1 1 260px", width: "auto" }}
                placeholder="Reason for refund (required)"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <button
                type="button"
                className={`${css.toolBtn} ${css.toolBtnDanger}`}
                onClick={() => void refund()}
                disabled={busy || !canRefund}
                data-tooltip={
                  canRefund ? "Reverse the whole invoice" : "Your role cannot refund sales"
                }
              >
                <IconRotateCcw size={15} />
                Refund full invoice
              </button>
            </div>
          )}
        </>
      ) : (
        <p className={css.pickerEmpty}>
          Scan or type the invoice number from the customer&apos;s bill to start a return.
        </p>
      )}
    </section>
  );
}
