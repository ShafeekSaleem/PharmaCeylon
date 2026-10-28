"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Alert } from "@/components/alert";
import { IconChevronLeft, IconPackage, IconReceipt } from "@/components/icons";
import { ActionButton, DataTable, PageHeader, StatusBadge, type Column } from "@/components/ui";
import { formatMoney } from "@/lib/money";
import { usePageChrome } from "@/lib/page-chrome-context";
import { SaleReceiptCopy } from "../components/sale-receipt-copy";
import { SaleRefundPanel } from "../components/sale-refund-panel";
import { PAYMENT_METHOD_LABELS } from "../constants";
import { useSaleDetail } from "../hooks/use-sale-detail";
import type { SaleDetail } from "../types";
import { formatDateTime, formatExpiry } from "../utils";
import css from "../sales.module.css";

type SaleItem = SaleDetail["items"][number];

const ITEM_COLUMNS: Column<SaleItem>[] = [
  {
    key: "product",
    header: "Product",
    render: (item) => (
      <span className={css.cellStack}>
        <span className={css.cellMain}>{item.product.name}</span>
        <span className={css.cellSub}>{item.product.sku}</span>
      </span>
    ),
  },
  {
    key: "batch",
    header: "Batch",
    width: "8rem",
    render: (item) => (
      <span className={css.cellStack}>
        <span>{item.batch.batchNo}</span>
        <span className={css.cellSub}>Exp {formatExpiry(item.batch.expiryDate)}</span>
      </span>
    ),
  },
  { key: "qty", header: "Qty", width: "4.5rem", align: "right", render: (item) => item.qty },
  {
    key: "unitPrice",
    header: "Unit price",
    width: "8rem",
    align: "right",
    render: (item) => <span className={css.amount}>{formatMoney(item.unitPrice)}</span>,
  },
  {
    key: "discount",
    header: "Discount",
    width: "7.5rem",
    align: "right",
    render: (item) => <span className={css.amount}>{formatMoney(item.discountAmount)}</span>,
  },
  {
    key: "lineTotal",
    header: "Total",
    width: "8.5rem",
    align: "right",
    render: (item) => <span className={css.amount}>{formatMoney(item.lineTotal)}</span>,
  },
  {
    // `null` without costs.view — formatMoney prints the dash.
    key: "unitCost",
    header: "Unit cost",
    width: "8rem",
    align: "right",
    render: (item) => <span className={css.amount}>{formatMoney(item.unitCost)}</span>,
  },
];

function paymentLabel(payment: SaleDetail["payments"][number]): string {
  const method = PAYMENT_METHOD_LABELS[payment.method] ?? payment.method;
  return Number(payment.amount) < 0 ? `Refund to ${method.toLowerCase()}` : method;
}

/**
 * One sale, read-only: what was sold from which batch, how it was paid and refunded, who sold
 * and dispensed it, and the customer and prescription it was rung up against.
 */
export default function SaleDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { data: sale, loading, error } = useSaleDetail(params?.id);
  const { setLastSegmentLabel } = usePageChrome();
  const [receiptOpen, setReceiptOpen] = useState(false);

  useEffect(() => {
    if (sale?.invoiceNo) setLastSegmentLabel(sale.invoiceNo);
    return () => setLastSegmentLabel(null);
  }, [sale?.invoiceNo, setLastSegmentLabel]);

  if (loading) return <div className={css.notice}>Loading sale…</div>;
  if (error || !sale) {
    return (
      <div className={css.page}>
        <Alert variant="error">{error ?? "Sale not found"}</Alert>
        <Link href="/sales">Back to sales history</Link>
      </div>
    );
  }

  const refundedTotal = sale.refunds.reduce((sum, refund) => sum + Number(refund.amount), 0);

  return (
    <div className={css.page}>
      <PageHeader
        title={sale.invoiceNo}
        description={`${formatDateTime(sale.soldAt)} · ${sale.branch.name}`}
        actions={
          <>
            <ActionButton
              variant="secondary"
              icon={<IconChevronLeft size={16} />}
              onClick={() => router.push("/sales")}
            >
              Sales history
            </ActionButton>
            <ActionButton icon={<IconReceipt size={16} />} onClick={() => setReceiptOpen(true)}>
              Receipt copy
            </ActionButton>
          </>
        }
      />

      <div className={css.detailLayout}>
        <div className={css.column}>
          <section className={css.card} aria-label="Sale details">
            <h2 className={css.cardTitle}>Sale</h2>
            <dl className={css.facts}>
              <div className={css.fact}>
                <dt>Status</dt>
                <dd>
                  <StatusBadge status={sale.status} label={sale.status === "posted" ? "Completed" : undefined} />
                </dd>
              </div>
              <div className={css.fact}>
                <dt>Sold</dt>
                <dd>{formatDateTime(sale.soldAt)}</dd>
              </div>
              <div className={css.fact}>
                <dt>Branch</dt>
                <dd>{sale.branch.name}</dd>
              </div>
              <div className={css.fact}>
                <dt>Sold by</dt>
                <dd>{sale.seller.fullName}</dd>
              </div>
              {sale.dispenser ? (
                <div className={css.fact}>
                  <dt>Dispensed by</dt>
                  <dd>{sale.dispenser.fullName}</dd>
                </div>
              ) : null}
              <div className={css.fact}>
                <dt>Customer</dt>
                <dd>
                  {sale.customer ? (
                    <Link href={`/customers?open=${sale.customer.id}`}>{sale.customer.fullName}</Link>
                  ) : (
                    <span className={css.muted}>Walk-in customer</span>
                  )}
                  {sale.customer?.phone ? <div className={css.cellSub}>{sale.customer.phone}</div> : null}
                </dd>
              </div>
              <div className={css.fact}>
                <dt>Prescription</dt>
                <dd>
                  {sale.prescription ? (
                    <>
                      <Link href={`/prescriptions?q=${encodeURIComponent(sale.prescription.rxNumber)}`}>
                        {sale.prescription.rxNumber}
                      </Link>
                      <div className={css.cellSub}>
                        {sale.prescription.patientName} · Dr {sale.prescription.doctorName}
                      </div>
                    </>
                  ) : (
                    <span className={css.muted}>None</span>
                  )}
                </dd>
              </div>
            </dl>
            {sale.notes ? <p className={css.cellSub}>Note: {sale.notes}</p> : null}
          </section>

          <section className={css.card} aria-label="Items">
            <h2 className={css.cardTitle}>Items</h2>
            <DataTable
              columns={ITEM_COLUMNS}
              data={sale.items}
              rowKey={(item) => item.id}
              pageSize={Math.max(sale.items.length, 1)}
              fixedLayout
              compact
              emptyIcon={<IconPackage size={28} />}
              emptyTitle="No items"
            />
          </section>
        </div>

        <div className={css.column}>
          <section className={css.card} aria-label="Totals">
            <h2 className={css.cardTitle}>Totals</h2>
            <div className={css.summaryRow}>
              <span>Subtotal</span>
              <span className={css.amount}>{formatMoney(sale.subtotal)}</span>
            </div>
            <div className={css.summaryRow}>
              <span>Discount</span>
              <span className={css.amount}>- {formatMoney(sale.discountTotal)}</span>
            </div>
            <div className={css.summaryRow}>
              <span>VAT</span>
              <span className={css.amount}>{formatMoney(sale.taxTotal)}</span>
            </div>
            <div className={css.summaryGrand}>
              <span>Total</span>
              <span className={css.amount}>{formatMoney(sale.grandTotal)}</span>
            </div>
            <div className={css.summaryRow}>
              <span>Paid</span>
              <span className={css.amount}>{formatMoney(sale.amountPaid)}</span>
            </div>
            <div className={css.summaryRow}>
              <span>Change</span>
              <span className={css.amount}>{formatMoney(sale.changeDue)}</span>
            </div>
            {refundedTotal > 0 ? (
              <div className={`${css.summaryRow} ${css.refundRow}`}>
                <span>Refunded</span>
                <span className={css.amount}>- {formatMoney(refundedTotal)}</span>
              </div>
            ) : null}
            <div className={css.summaryRow}>
              <span>Cost of goods</span>
              <span className={css.amount}>{formatMoney(sale.costTotal)}</span>
            </div>
            {sale.costTotal === null ? (
              <p className={css.cellSub}>
                Historical cost is unavailable because unit costs were not saved with this sale.
              </p>
            ) : null}
          </section>

          <section className={css.card} aria-label="Payments">
            <h2 className={css.cardTitle}>Payments</h2>
            <ul className={css.list}>
              {sale.payments.map((payment) => (
                <li key={payment.id} className={css.listItem}>
                  <span className={css.cellStack}>
                    <span>{paymentLabel(payment)}</span>
                    <span className={css.cellSub}>
                      {formatDateTime(payment.createdAt)}
                      {payment.reference ? ` · ${payment.reference}` : ""}
                    </span>
                  </span>
                  <span className={`${css.amount}${Number(payment.amount) < 0 ? ` ${css.refundRow}` : ""}`}>
                    {formatMoney(payment.amount)}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <SaleRefundPanel sale={sale} />

          {sale.refunds.length > 0 ? (
            <section className={css.card} aria-label="Refunds">
              <h2 className={css.cardTitle}>Refunds</h2>
              <ul className={css.list}>
                {sale.refunds.map((refund) => (
                  <li key={refund.id} className={css.listItem}>
                    <span className={css.cellStack}>
                      <span>{refund.returnNumber}</span>
                      <span className={css.cellSub}>{formatDateTime(refund.createdAt)}</span>
                    </span>
                    <span className={css.amount}>{formatMoney(refund.amount)}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </div>

      <SaleReceiptCopy sale={sale} open={receiptOpen} onClose={() => setReceiptOpen(false)} />
    </div>
  );
}
