"use client";

import { useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/alert";
import { IconPlus, IconTrash } from "@/components/icons";
import { Modal, ModalButton, ModalFooter } from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import { useUnbilledDeliveries } from "../hooks/use-ledger";
import { useSuppliers } from "../hooks/use-suppliers";
import type { InvoiceDetail } from "../ledger-types";
import css from "../purchasing.module.css";
import { formatMoney, todayIsoDate } from "../utils";
import { PurchasingSelect } from "./purchasing-select";

type Props = {
  open: boolean;
  onClose: () => void;
  onRecorded: (invoice: InvoiceDetail) => void;
  /** Open already pointed at a supplier, and optionally one delivery, e.g. from a placeholder. */
  preset?: { supplierId?: string; receiptId?: string } | null;
};

type Line = {
  key: string;
  /** The delivery this line came from, so unticking the delivery takes its lines away. */
  fromReceiptId: string | null;
  productId: string | null;
  productName: string;
  description: string;
  qty: string;
  unitCost: string;
};

function addDays(iso: string, days: number) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

let seq = 0;
const key = () => `l${++seq}`;

/**
 * Type the supplier's invoice in, against the deliveries it bills for.
 *
 * Ticking a delivery fills in what actually arrived, at the cost it was booked at, so the only
 * typing left is wherever the paper disagrees — which is exactly what the three-way match then
 * shows. A line with no product (freight, a handling fee) can be added by hand.
 */
export function RecordInvoiceModal({ open, onClose, onRecorded, preset }: Props) {
  const suppliers = useSuppliers();
  const [supplierId, setSupplierId] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(todayIsoDate());
  const [dueDate, setDueDate] = useState("");
  const [dueTouched, setDueTouched] = useState(false);
  const [receiptIds, setReceiptIds] = useState<Set<string>>(new Set());
  const [lines, setLines] = useState<Line[]>([]);
  const [taxAmount, setTaxAmount] = useState("");
  const [shippingAmount, setShippingAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const deliveries = useUnbilledDeliveries(open && supplierId ? supplierId : null);

  useEffect(() => {
    if (!open) return;
    setSupplierId(preset?.supplierId ?? "");
    setInvoiceNumber("");
    setInvoiceDate(todayIsoDate());
    setDueDate("");
    setDueTouched(false);
    setReceiptIds(new Set());
    setLines([]);
    setTaxAmount("");
    setShippingAmount("");
    setNotes("");
    setError(null);
    setSaving(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const supplier = suppliers.rows.find((s) => s.id === supplierId) ?? null;

  // The due date follows the supplier's terms until someone types their own.
  useEffect(() => {
    if (!dueTouched && supplier && invoiceDate) {
      setDueDate(addDays(invoiceDate, supplier.paymentTermsDays ?? 30));
    }
  }, [supplier, invoiceDate, dueTouched]);

  // A preset delivery is ticked as soon as the supplier's deliveries have loaded.
  useEffect(() => {
    if (!preset?.receiptId || deliveries.loading) return;
    const found = deliveries.rows.find((d) => d.id === preset.receiptId);
    if (found && !receiptIds.has(found.id)) toggleDelivery(found.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset?.receiptId, deliveries.loading, deliveries.rows]);

  // Both updates say where the delivery should end up rather than flipping it, so React running
  // an updater twice (it does in development) cannot tick it twice or add its lines twice.
  function toggleDelivery(id: string) {
    const delivery = deliveries.rows.find((d) => d.id === id);
    if (!delivery) return;
    const tick = !receiptIds.has(id);
    setReceiptIds((prev) => {
      const next = new Set(prev);
      if (tick) next.add(id);
      else next.delete(id);
      return next;
    });
    setLines((current) => {
      const others = current.filter((line) => line.fromReceiptId !== id);
      if (!tick) return others;
      return [
        ...others,
        ...delivery.lines.map((line) => ({
          key: key(),
          fromReceiptId: id,
          productId: line.product.id,
          productName: line.product.name,
          description: "",
          qty: String(line.qty),
          unitCost: line.unitCost ?? "",
        })),
      ];
    });
  }

  function updateLine(lineKey: string, patch: Partial<Line>) {
    setLines((current) => current.map((line) => (line.key === lineKey ? { ...line, ...patch } : line)));
  }

  const totals = useMemo(() => {
    const subtotal = lines.reduce(
      (sum, line) => sum + (Number(line.qty) || 0) * (Number(line.unitCost) || 0),
      0,
    );
    const tax = Number(taxAmount) || 0;
    const shipping = Number(shippingAmount) || 0;
    return { subtotal, tax, shipping, total: subtotal + tax + shipping };
  }, [lines, taxAmount, shippingAmount]);

  const valid =
    !!supplierId &&
    invoiceNumber.trim().length > 0 &&
    !!invoiceDate &&
    lines.length > 0 &&
    lines.every(
      (line) =>
        (line.productId || line.description.trim()) &&
        Number(line.qty) >= 1 &&
        line.unitCost !== "" &&
        Number(line.unitCost) >= 0,
    ) &&
    totals.total > 0;

  async function submit() {
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      const invoice = await apiJson<InvoiceDetail>("/purchasing/invoices", {
        method: "POST",
        body: JSON.stringify({
          supplierId,
          invoiceNumber: invoiceNumber.trim(),
          invoiceDate,
          ...(dueDate ? { dueDate } : {}),
          receiptIds: [...receiptIds],
          lines: lines.map((line) => ({
            ...(line.productId ? { productId: line.productId } : { description: line.description.trim() }),
            qty: Number(line.qty),
            unitCost: Number(line.unitCost).toFixed(2),
          })),
          ...(taxAmount.trim() ? { taxAmount: Number(taxAmount).toFixed(2) } : {}),
          ...(shippingAmount.trim() ? { shippingAmount: Number(shippingAmount).toFixed(2) } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        }),
      });
      onRecorded(invoice);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to record the invoice");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => !saving && onClose()}
      title="Record supplier invoice"
      description="Type the invoice in as the supplier printed it. Deliveries you tick fill in what arrived."
      size="xl"
      canDismiss={!saving}
      footer={
        <ModalFooter>
          <ModalButton onClick={onClose} disabled={saving}>
            Cancel
          </ModalButton>
          <ModalButton variant="primary" onClick={() => void submit()} loading={saving} disabled={!valid}>
            Record invoice
          </ModalButton>
        </ModalFooter>
      }
    >
      {error && <Alert variant="error">{error}</Alert>}

      <div className={css.formGrid}>
        <div className={css.field}>
          <PurchasingSelect
            label="Supplier"
            required
            value={supplierId}
            options={suppliers.rows.map((s) => ({ value: s.id, label: s.name, meta: s.code }))}
            placeholder={suppliers.loading ? "Loading…" : "Select supplier…"}
            searchPlaceholder="Search suppliers…"
            onChange={(value) => {
              setSupplierId(value);
              setReceiptIds(new Set());
              setLines([]);
            }}
            disabled={saving}
          />
        </div>
        <div className={css.field}>
          <label className={css.fieldLabel} htmlFor="inv-number">
            Supplier&apos;s invoice number
          </label>
          <input
            id="inv-number"
            className={css.input}
            placeholder="As printed on the invoice"
            value={invoiceNumber}
            onChange={(e) => setInvoiceNumber(e.target.value)}
            disabled={saving}
          />
        </div>
        <div className={css.field}>
          <label className={css.fieldLabel} htmlFor="inv-date">
            Invoice date
          </label>
          <input
            id="inv-date"
            type="date"
            className={css.input}
            value={invoiceDate}
            max={todayIsoDate()}
            onChange={(e) => setInvoiceDate(e.target.value)}
            disabled={saving}
          />
        </div>
        <div className={css.field}>
          <label className={css.fieldLabel} htmlFor="inv-due">
            Due date
          </label>
          <input
            id="inv-due"
            type="date"
            className={css.input}
            value={dueDate}
            min={invoiceDate}
            onChange={(e) => {
              setDueTouched(true);
              setDueDate(e.target.value);
            }}
            disabled={saving}
          />
          {supplier && !dueTouched ? (
            <span className={css.fieldHint}>
              From {supplier.name}&apos;s terms: {supplier.paymentTermsDays ?? 30} days
            </span>
          ) : null}
        </div>
      </div>

      {supplierId && (
        <section className={css.suggestGroup}>
          <header className={css.suggestHeader}>
            <div>
              <h3 className={css.suggestSupplier}>Deliveries this invoice covers</h3>
              <p className={css.muted}>
                Deliveries from {supplier?.name ?? "this supplier"} that no invoice has been recorded
                against yet.
              </p>
            </div>
          </header>
          {deliveries.loading ? (
            <p className={css.muted} style={{ padding: "0.75rem 0.9rem" }}>
              Loading deliveries…
            </p>
          ) : deliveries.rows.length === 0 ? (
            <p className={css.muted} style={{ padding: "0.75rem 0.9rem" }}>
              No deliveries are waiting for an invoice. You can still record one with lines below.
            </p>
          ) : (
            <ul className={css.plainList} style={{ listStyle: "none", paddingLeft: "0.9rem" }}>
              {deliveries.rows.map((delivery) => (
                <li key={delivery.id}>
                  <label className={css.checkboxRow}>
                    <input
                      type="checkbox"
                      checked={receiptIds.has(delivery.id)}
                      onChange={() => toggleDelivery(delivery.id)}
                      disabled={saving}
                    />
                    <span className={css.cellStrong}>{delivery.grnNumber}</span>
                    <span className={css.muted}>
                      {delivery.receivedOn} · {delivery.poNumber} · {delivery.lines.length} line
                      {delivery.lines.length === 1 ? "" : "s"}
                      {delivery.supplierDeliveryNote ? ` · note ${delivery.supplierDeliveryNote}` : ""}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className={css.suggestGroup}>
        <header className={css.suggestHeader}>
          <div>
            <h3 className={css.suggestSupplier}>Lines as billed</h3>
            <p className={css.muted}>Correct any quantity or price to match the paper invoice.</p>
          </div>
          <button
            type="button"
            className={css.actionBtn}
            onClick={() =>
              setLines((current) => [
                ...current,
                {
                  key: key(),
                  fromReceiptId: null,
                  productId: null,
                  productName: "",
                  description: "",
                  qty: "1",
                  unitCost: "",
                },
              ])
            }
            disabled={saving}
          >
            <IconPlus size={14} />
            Add a charge
          </button>
        </header>
        {lines.length === 0 ? (
          <p className={css.muted} style={{ padding: "0.75rem 0.9rem" }}>
            Tick a delivery above, or add a charge.
          </p>
        ) : (
          <div className={css.tableScroll}>
            <table className={css.suggestTable}>
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col">Qty</th>
                  <th scope="col">Unit cost</th>
                  <th scope="col">Line total</th>
                  <th scope="col" aria-label="Remove" />
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.key}>
                    <td>
                      {line.productId ? (
                        <span className={css.cellStrong}>{line.productName}</span>
                      ) : (
                        <input
                          className={css.input}
                          placeholder="e.g. Delivery charge"
                          aria-label="Charge description"
                          value={line.description}
                          onChange={(e) => updateLine(line.key, { description: e.target.value })}
                          disabled={saving}
                        />
                      )}
                    </td>
                    <td style={{ width: 90 }}>
                      <input
                        type="number"
                        min={1}
                        className={css.input}
                        aria-label={`Quantity for ${line.productName || line.description || "charge"}`}
                        value={line.qty}
                        onChange={(e) => updateLine(line.key, { qty: e.target.value })}
                        disabled={saving}
                      />
                    </td>
                    <td style={{ width: 130 }}>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        className={css.input}
                        aria-label={`Unit cost for ${line.productName || line.description || "charge"}`}
                        value={line.unitCost}
                        onChange={(e) => updateLine(line.key, { unitCost: e.target.value })}
                        disabled={saving}
                      />
                    </td>
                    <td>{formatMoney((Number(line.qty) || 0) * (Number(line.unitCost) || 0))}</td>
                    <td>
                      <button
                        type="button"
                        className={css.actionBtn}
                        aria-label="Remove line"
                        onClick={() => setLines((current) => current.filter((l) => l.key !== line.key))}
                        disabled={saving}
                      >
                        <IconTrash size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className={css.formGrid}>
        <div className={css.field}>
          <label className={css.fieldLabel} htmlFor="inv-tax">
            Tax on the invoice
          </label>
          <input
            id="inv-tax"
            type="number"
            min={0}
            step="0.01"
            className={css.input}
            placeholder="0.00"
            value={taxAmount}
            onChange={(e) => setTaxAmount(e.target.value)}
            disabled={saving}
          />
          <span className={css.fieldHint}>The figure printed on the invoice.</span>
        </div>
        <div className={css.field}>
          <label className={css.fieldLabel} htmlFor="inv-shipping">
            Shipping / other
          </label>
          <input
            id="inv-shipping"
            type="number"
            min={0}
            step="0.01"
            className={css.input}
            placeholder="0.00"
            value={shippingAmount}
            onChange={(e) => setShippingAmount(e.target.value)}
            disabled={saving}
          />
        </div>
        <div className={css.field}>
          <label className={css.fieldLabel} htmlFor="inv-notes">
            Notes
          </label>
          <input
            id="inv-notes"
            className={css.input}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={saving}
          />
        </div>
        <div className={css.field}>
          <span className={css.fieldLabel}>Invoice total</span>
          <span className={css.cellStrong} style={{ fontSize: "1.1rem" }}>
            {formatMoney(totals.total)}
          </span>
          <span className={css.fieldHint}>
            Goods {formatMoney(totals.subtotal)} · tax {formatMoney(totals.tax)} · shipping{" "}
            {formatMoney(totals.shipping)}
          </span>
        </div>
      </div>
    </Modal>
  );
}
