"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  IconAlertTriangle,
  IconBarcodeScan,
  IconCalendar,
  IconChevronDown,
  IconFileText,
  IconMinus,
  IconPause,
  IconPlus,
  IconStethoscope,
  IconTrash,
  IconUser,
} from "@/components/icons";
import { PRODUCT_PLACEHOLDER_SRC } from "@/lib/product-placeholder";
import { StatusBadge } from "@/components/ui";
import type { Customer, PosMode, Prescription, ResolvedCartLine } from "../types";
import { formatAmount, formatExpiry, productSubtitle } from "../utils";
import css from "../pos.module.css";

type Props = {
  invoiceLabel: string;
  lines: ResolvedCartLine[];
  mode: PosMode;
  customer: Customer | null;
  prescription: Prescription | null;
  cashierName: string;
  cashierInitials: string;
  notes: string;
  rxRequired: boolean;
  /** Hold reference while this cart is an un-modified recall; clears once re-held or sold. */
  recalledHoldRef: string | null;
  lastAddedKey: string | null;
  addCount: number;
  onNotesChange: (value: string) => void;
  onOpenCustomer: () => void;
  onOpenPrescription: () => void;
  onOpenBatch: (line: ResolvedCartLine) => void;
  onStepQty: (key: string, delta: number) => void;
  onSetQty: (key: string, qty: number) => void;
  onSetDiscount: (key: string, percent: number) => void;
  onRemove: (key: string) => void;
};

export function PosCartPanel({
  invoiceLabel,
  lines,
  mode,
  customer,
  prescription,
  cashierName,
  cashierInitials,
  notes,
  rxRequired,
  recalledHoldRef,
  lastAddedKey,
  addCount,
  onNotesChange,
  onOpenCustomer,
  onOpenPrescription,
  onOpenBatch,
  onStepQty,
  onSetQty,
  onSetDiscount,
  onRemove,
}: Props) {
  const [flashKey, setFlashKey] = useState<string | null>(null);

  useEffect(() => {
    if (!lastAddedKey || addCount === 0) return;
    setFlashKey(lastAddedKey);
    const timer = setTimeout(() => setFlashKey(null), 700);
    return () => clearTimeout(timer);
  }, [lastAddedKey, addCount]);

  const showRxPicker = mode === "prescription" || rxRequired || prescription !== null;
  const saleStatus =
    lines.length === 0
      ? ({ status: "draft", label: "Ready", variant: "muted" } as const)
      : ({ status: "in_progress", label: "In progress", variant: "success" } as const);

  return (
    <section className={css.card}>
      <header className={css.saleHeader}>
        <h2 className={css.saleHeaderTitle}>Current Sale</h2>
        <span className={css.invoiceChip}>{invoiceLabel}</span>
        <StatusBadge
          status={saleStatus.status}
          label={saleStatus.label}
          variant={saleStatus.variant}
        />
        {recalledHoldRef && (
          <span
            className={css.recalledChip}
            data-tooltip="Restored from a parked sale — completing or re-holding will clear this tag"
          >
            <IconPause size={11} />
            Recalled {recalledHoldRef}
          </span>
        )}
        <span className={css.saleHeaderSpacer} />
        <span className={css.fieldHint}>
          {lines.length} item{lines.length === 1 ? "" : "s"}
        </span>
      </header>

      <div className={css.partyRow}>
        <button type="button" className={css.partyPicker} onClick={onOpenCustomer}>
          <span className={css.partyIcon}>
            <IconUser size={14} />
          </span>
          <span className={css.partyText}>
            <span className={css.partyLabel}>Customer</span>
            <span className={`${css.partyValue}${customer ? "" : ` ${css.partyValueMuted}`}`}>
              {customer ? customer.fullName : "Walk-in Customer"}
            </span>
          </span>
          <IconChevronDown size={14} className={css.partyChevron} />
        </button>

        {showRxPicker ? (
          <button
            type="button"
            className={`${css.partyPicker}${rxRequired && !prescription ? ` ${css.partyPickerRequired}` : ""}`}
            onClick={onOpenPrescription}
          >
            <span className={css.partyIcon}>
              <IconStethoscope size={14} />
            </span>
            <span className={css.partyText}>
              <span className={css.partyLabel}>Prescription</span>
              <span
                className={`${css.partyValue}${prescription ? "" : ` ${css.partyValueMuted}`}`}
              >
                {prescription
                  ? `${prescription.rxNumber} · ${prescription.patientName}`
                  : rxRequired
                    ? "Required — link an Rx"
                    : "Not linked"}
              </span>
            </span>
            <IconChevronDown size={14} className={css.partyChevron} />
          </button>
        ) : (
          <div className={`${css.partyPicker} ${css.partyPickerStatic}`}>
            <span className={css.partyIcon}>
              <IconStethoscope size={14} />
            </span>
            <span className={css.partyText}>
              <span className={css.partyLabel}>Prescription</span>
              <span className={`${css.partyValue} ${css.partyValueMuted}`}>
                Not needed for this cart
              </span>
            </span>
          </div>
        )}

        <div className={`${css.partyPicker} ${css.partyPickerStatic}`}>
          <span className={css.partyAvatar}>{cashierInitials}</span>
          <span className={css.partyText}>
            <span className={css.partyLabel}>Salesperson / Cashier</span>
            <span className={css.partyValue}>{cashierName}</span>
          </span>
        </div>
      </div>

      <div className={css.cartBody}>
        {lines.length === 0 ? (
          <div className={css.emptyCart}>
            <span className={css.emptyCartIcon}>
              <IconBarcodeScan size={22} />
            </span>
            <span className={css.emptyCartTitle}>Cart is empty</span>
            <span className={css.emptyCartHint}>
              Scan a barcode or press <span className={css.kbd}>/</span> to search the catalog.
            </span>
          </div>
        ) : (
          <div className={css.cartWrap}>
            <table className={css.cartTable}>
            <thead>
              <tr>
                <th className={css.colIndex}>#</th>
                <th>Product</th>
                <th>Batch</th>
                <th>Expiry</th>
                <th>Qty</th>
                <th className={css.colNum}>Unit price</th>
                <th className={css.colNum}>Disc %</th>
                <th className={css.colNum}>Line total</th>
                <th className={css.colActions} aria-label="Remove" />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => (
                <tr
                  key={line.key}
                  className={[
                    css.cartRow,
                    flashKey === line.key ? css.cartRowFlash : "",
                    line.overStock ? css.cartRowInvalid : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <td className={css.colIndex}>{index + 1}</td>
                  <td>
                    <div className={css.productCell}>
                      <img
                        src={line.product.imageUrl ?? PRODUCT_PLACEHOLDER_SRC}
                        alt=""
                        aria-hidden
                        className={
                          line.product.imageUrl
                            ? css.thumb
                            : `${css.thumb} ${css.thumbPlaceholder}`
                        }
                      />
                      <span className={css.productText}>
                        <Link href={`/products/${line.productId}`} className={css.productLink}>
                          {line.product.name}
                        </Link>
                        <span className={css.productSub}>
                          {productSubtitle(line.product)}
                          {line.product.isControlled ? (
                            <span className={css.tagControlled}>Ctrl</span>
                          ) : line.product.requiresPrescription ? (
                            <span className={css.tagRx}>Rx</span>
                          ) : (
                            <span className={css.tagOtc}>OTC</span>
                          )}
                        </span>
                      </span>
                    </div>
                  </td>
                  <td>
                    <button
                      type="button"
                      className={css.batchBtn}
                      onClick={() => onOpenBatch(line)}
                      data-tooltip="Change batch (FEFO picked by default)"
                    >
                      {line.batch.batchNo}
                      <IconChevronDown size={12} />
                    </button>
                  </td>
                  <td>
                    {line.batch.nearExpiry ? (
                      <span className={css.expiryNear}>
                        <IconCalendar size={11} />
                        {formatExpiry(line.batch.expiryDate)}
                      </span>
                    ) : (
                      <span className={css.expiryText}>
                        {formatExpiry(line.batch.expiryDate)}
                      </span>
                    )}
                  </td>
                  <td>
                    <div className={css.qtyGroup}>
                      <button
                        type="button"
                        className={css.qtyBtn}
                        onClick={() => onStepQty(line.key, -1)}
                        aria-label={`Decrease ${line.product.name} quantity`}
                      >
                        <IconMinus size={13} />
                      </button>
                      <input
                        type="number"
                        min={1}
                        max={line.batch.qtyOnHand}
                        className={css.qtyInput}
                        value={line.qty}
                        aria-label={`${line.product.name} quantity`}
                        onChange={(e) => {
                          const next = Number(e.target.value);
                          if (Number.isFinite(next)) onSetQty(line.key, Math.trunc(next));
                        }}
                        onFocus={(e) => e.currentTarget.select()}
                      />
                      <button
                        type="button"
                        className={css.qtyBtn}
                        onClick={() => onStepQty(line.key, 1)}
                        disabled={line.qty >= line.batch.qtyOnHand}
                        aria-label={`Increase ${line.product.name} quantity`}
                      >
                        <IconPlus size={13} />
                      </button>
                    </div>
                    {line.overStock && (
                      <div className={css.productSub}>
                        <IconAlertTriangle size={11} />
                        only {line.batch.qtyOnHand} left
                      </div>
                    )}
                  </td>
                  <td className={css.colNum}>{formatAmount(line.unitPrice)}</td>
                  <td className={css.colNum}>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={1}
                      className={`${css.discountInput}${line.discountPercent > 0 ? ` ${css.discountActive}` : ""}`}
                      value={line.discountPercent}
                      aria-label={`${line.product.name} discount percent`}
                      onChange={(e) => onSetDiscount(line.key, Number(e.target.value))}
                      onFocus={(e) => e.currentTarget.select()}
                    />
                  </td>
                  <td className={`${css.colNum} ${css.lineTotal}`}>
                    {formatAmount(line.lineTotal)}
                  </td>
                  <td className={css.colActions}>
                    <button
                      type="button"
                      className={`${css.iconBtn} ${css.iconBtnDanger}`}
                      onClick={() => onRemove(line.key)}
                      aria-label={`Remove ${line.product.name}`}
                      data-tooltip="Remove line"
                    >
                      <IconTrash size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      <div className={css.noteRow}>
        <input
          type="text"
          className={css.noteInput}
          placeholder="Add a note to this sale…"
          value={notes}
          maxLength={512}
          aria-label="Sale note"
          onChange={(e) => onNotesChange(e.target.value)}
        />
        <span className={css.partyIcon} aria-hidden>
          <IconFileText size={14} />
        </span>
      </div>
    </section>
  );
}
