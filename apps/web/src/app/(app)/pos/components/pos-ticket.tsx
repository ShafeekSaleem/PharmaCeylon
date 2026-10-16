"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  IconBarcodeScan,
  IconEdit,
  IconFileText,
  IconMinus,
  IconPlus,
  IconUser,
  IconX,
} from "@/components/icons";
import { PAYMENT_METHOD_LABELS } from "../constants";
import type {
  CartTotals,
  Customer,
  PosProduct,
  Prescription,
  RecentSale,
  ResolvedCartLine,
  SaleReceipt,
} from "../types";
import { formatAmount, formatExpiry, formatMoney, formatTime, round2 } from "../utils";
import tcss from "../till.module.css";

/** OTC, Rx or Controlled — the one tag every product line and search result carries. */
export function ProductTag({ product }: { product: PosProduct }) {
  if (product.isControlled) return <span className={`${tcss.tag} ${tcss.tagCtrl}`}>CONTROLLED</span>;
  if (product.requiresPrescription) return <span className={`${tcss.tag} ${tcss.tagRx}`}>Rx</span>;
  return <span className={tcss.tag}>OTC</span>;
}

/** Register text arrives in capitals; a line reads better in sentence case. */
function sentence(text: string): string {
  if (text !== text.toUpperCase()) return text;
  const lower = text.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * What the product is, once: the generic name, plus strength and form only when the generic
 * doesn't already say them. Retail lines without a generic show their category.
 */
export function lineSubtitle(product: PosProduct): string {
  const generic = product.genericName?.trim() ?? "";
  if (!generic) return product.commercialCategoryName ?? product.sku;
  const parts = [generic];
  const has = (part: string | null) => !!part && generic.toLowerCase().includes(part.trim().toLowerCase());
  if (product.strength && !has(product.strength)) parts.push(product.strength);
  if (product.dosageForm && !has(product.dosageForm)) parts.push(product.dosageForm);
  return sentence(parts.join(" ")).replace(/\s+/g, " ");
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

function expiryFlag(daysToExpiry: number): string {
  if (daysToExpiry <= 0) return "Expires today";
  if (daysToExpiry === 1) return "Expires tomorrow";
  if (daysToExpiry <= 45) return `Expires in ${daysToExpiry} days`;
  return "Expires soon";
}

const DISCOUNT_STEPS = [5, 10, 15, 20];

/* ── Quick picks ──────────────────────────────────────────── */

/**
 * The branch's fast movers: most units sold in the last 30 days, then most sale lines in 90,
 * then whatever sold most recently — so a new branch still gets picks from its first sales.
 */
export function rankQuickPicks(products: PosProduct[], recentSales: RecentSale[], limit: number): PosProduct[] {
  const recentRank = new Map<string, number>();
  recentSales.forEach((sale, index) => {
    for (const id of sale.productIds) if (!recentRank.has(id)) recentRank.set(id, index);
  });
  return products
    .filter((p) => p.qtyOnHand > 0 && !p.isControlled)
    .filter((p) => p.units30d > 0 || p.lines90d > 0 || recentRank.has(p.id))
    .sort(
      (a, b) =>
        b.units30d - a.units30d ||
        b.lines90d - a.lines90d ||
        (recentRank.get(a.id) ?? 9999) - (recentRank.get(b.id) ?? 9999) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, limit);
}

function QuickPicks({
  products,
  recentSales,
  rows,
  onAdd,
}: {
  products: PosProduct[];
  recentSales: RecentSale[];
  rows: 1 | 2;
  onAdd: (product: PosProduct) => void;
}) {
  const picks = useMemo(() => rankQuickPicks(products, recentSales, rows * 7), [products, recentSales, rows]);
  if (picks.length === 0) return null;
  return (
    <div className={tcss.picks}>
      <div className={tcss.picksHead}>
        <span className={tcss.label}>Quick picks</span>
        <span className={tcss.picksHint}>Best sellers at this branch</span>
      </div>
      <div className={`${tcss.picksGrid} ${rows === 1 ? tcss.picksOneRow : tcss.picksTwoRows}`}>
        {picks.map((product) => (
          <button
            key={product.id}
            type="button"
            className={`${tcss.pick}${rows === 2 ? ` ${tcss.pickTall}` : ""}`}
            onClick={() => onAdd(product)}
            title={`${product.name} · ${product.qtyOnHand} in stock`}
          >
            <span className={tcss.pickName}>{product.name}</span>
            <span className={tcss.pickPrice}>{formatAmount(product.batches[0]?.sellingPrice ?? 0)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ── One line ─────────────────────────────────────────────── */

function DiscountEditor({
  line,
  onSetDiscount,
  onClose,
}: {
  line: ResolvedCartLine;
  onSetDiscount: (key: string, percent: number) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState(line.discountPercent ? String(line.discountPercent) : "");

  useEffect(() => {
    function onDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  function apply(percent: number) {
    const clamped = Math.min(Math.max(Number.isFinite(percent) ? percent : 0, 0), 100);
    setValue(clamped ? String(clamped) : "");
    onSetDiscount(line.key, clamped);
  }

  const percent = Number(value) || 0;
  const newPrice = round2(line.unitPrice * (1 - percent / 100));

  return (
    <div
      ref={ref}
      className={tcss.popover}
      role="dialog"
      aria-label={`Discount on ${line.product.name}`}
      onKeyDown={(e) => {
        if (e.key === "Escape" || e.key === "Enter") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className={tcss.popoverRow}>
        <label htmlFor={`disc-${line.key}`}>Discount</label>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            id={`disc-${line.key}`}
            className={tcss.popoverInput}
            type="number"
            min={0}
            max={100}
            step={1}
            inputMode="decimal"
            placeholder="0"
            autoFocus
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              onSetDiscount(line.key, Math.min(Math.max(Number(e.target.value) || 0, 0), 100));
            }}
            onFocus={(e) => e.currentTarget.select()}
          />
          %
        </span>
      </div>
      <div className={tcss.popoverChips}>
        {DISCOUNT_STEPS.map((step) => (
          <button
            key={step}
            type="button"
            className={`${tcss.smallBtn}${percent === step ? ` ${tcss.smallBtnOn}` : ""}`}
            onClick={() => apply(step)}
          >
            {step}%
          </button>
        ))}
      </div>
      <div className={tcss.popoverFoot}>
        <span>
          {formatAmount(line.unitPrice)} → <b style={{ color: "var(--pc-foreground)" }}>{formatAmount(newPrice)}</b> each
        </span>
        <span style={{ display: "flex", gap: 6 }}>
          {line.discountPercent > 0 && (
            <button type="button" className={tcss.smallBtn} onClick={() => apply(0)}>
              Remove
            </button>
          )}
          <button type="button" className={`${tcss.smallBtn} ${tcss.smallBtnPrimary}`} onClick={onClose}>
            Done
          </button>
        </span>
      </div>
    </div>
  );
}

function TicketLine({
  line,
  scanned,
  onOpenBatch,
  onStepQty,
  onSetQty,
  onSetDiscount,
  onRemove,
}: {
  line: ResolvedCartLine;
  scanned: boolean;
  onOpenBatch: (line: ResolvedCartLine) => void;
  onStepQty: (key: string, delta: number) => void;
  onSetQty: (key: string, qty: number) => void;
  onSetDiscount: (key: string, percent: number) => void;
  onRemove: (key: string) => void;
}) {
  const [editingDiscount, setEditingDiscount] = useState(false);
  const discounted = line.discountPercent > 0;
  const netUnit = round2(line.unitPrice * (1 - line.discountPercent / 100));
  const low = !line.overStock && line.product.stockStatus !== "ok" && line.product.qtyOnHand > 0;

  return (
    <div
      className={[
        tcss.line,
        scanned ? tcss.lineScanned : "",
        line.overStock ? tcss.lineInvalid : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className={tcss.lineMain}>
        <div className={tcss.lineTitle}>
          <Link href={`/products/${line.productId}`} className={tcss.lineName}>
            {line.product.name}
          </Link>
          <ProductTag product={line.product} />
          {line.overStock && (
            <span className={`${tcss.flag} ${tcss.flagDanger}`}>Only {line.batch.qtyOnHand} in stock</span>
          )}
          {low && <span className={`${tcss.flag} ${tcss.flagWarn}`}>Only {line.product.qtyOnHand} left</span>}
          {line.batch.nearExpiry && (
            <span className={`${tcss.flag} ${tcss.flagWarn}`}>{expiryFlag(line.batch.daysToExpiry)}</span>
          )}
          {scanned && <span className={`${tcss.flag} ${tcss.flagScan}`}>Just added</span>}
        </div>
        <div className={tcss.lineMeta}>
          {lineSubtitle(line.product)} ·{" "}
          <button
            type="button"
            className={tcss.linkBtn}
            onClick={() => onOpenBatch(line)}
            title="Change batch — the soonest expiry is picked first"
          >
            Batch {line.batch.batchNo}
          </button>{" "}
          · Exp {formatExpiry(line.batch.expiryDate)}
        </div>
      </div>

      <div className={tcss.stepper}>
        <button
          type="button"
          className={tcss.stepBtn}
          onClick={() => onStepQty(line.key, -1)}
          aria-label={`One fewer ${line.product.name}`}
        >
          <IconMinus size={15} />
        </button>
        <input
          type="number"
          min={1}
          max={line.batch.qtyOnHand}
          className={tcss.qtyInput}
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
          className={tcss.stepBtn}
          onClick={() => onStepQty(line.key, 1)}
          disabled={line.qty >= line.batch.qtyOnHand}
          aria-label={`One more ${line.product.name}`}
        >
          <IconPlus size={15} />
        </button>
      </div>

      <div className={tcss.priceCell}>
        <button
          type="button"
          className={`${tcss.priceBtn}${editingDiscount ? ` ${tcss.priceBtnOpen}` : ""}`}
          onClick={() => setEditingDiscount((v) => !v)}
          aria-haspopup="dialog"
          aria-expanded={editingDiscount}
          aria-label={`Price and discount for ${line.product.name}`}
        >
          {discounted ? (
            <>
              <span className={tcss.priceWas}>{formatAmount(line.unitPrice)}</span>
              <span className={tcss.priceNow}>
                {formatAmount(netUnit)}
                <span className={tcss.discPill}>−{formatAmount(line.discountPercent).replace(/\.00$/, "")}%</span>
              </span>
            </>
          ) : (
            <>
              <span className={tcss.priceNow}>{formatAmount(line.unitPrice)}</span>
              <span className={tcss.priceHint}>Discount</span>
            </>
          )}
        </button>
        {editingDiscount && (
          <DiscountEditor line={line} onSetDiscount={onSetDiscount} onClose={() => setEditingDiscount(false)} />
        )}
      </div>

      <div className={tcss.lineTotal}>{formatAmount(line.lineTotal)}</div>

      <button
        type="button"
        className={tcss.removeBtn}
        onClick={() => onRemove(line.key)}
        aria-label={`Remove ${line.product.name}`}
      >
        <IconX size={16} />
      </button>
    </div>
  );
}

/* ── The ticket ───────────────────────────────────────────── */

type TicketProps = {
  lines: ResolvedCartLine[];
  totals: CartTotals;
  scannedKey: string | null;
  customer: Customer | null;
  prescription: Prescription | null;
  /** Lines that can only be sold against a prescription. */
  rxNeededCount: number;
  notes: string;
  recalledHoldRef: string | null;
  products: PosProduct[];
  recentSales: RecentSale[];
  onAddProduct: (product: PosProduct) => void;
  onNotesChange: (value: string) => void;
  onOpenCustomer: () => void;
  onOpenPrescription: () => void;
  onOpenBatch: (line: ResolvedCartLine) => void;
  onStepQty: (key: string, delta: number) => void;
  onSetQty: (key: string, qty: number) => void;
  onSetDiscount: (key: string, percent: number) => void;
  onRemove: (key: string) => void;
  onClear: () => void;
};

/** The sale being rung up: who it's for, what's in it, and the branch's quick picks. */
export function PosTicket({
  lines,
  totals,
  scannedKey,
  customer,
  prescription,
  rxNeededCount,
  notes,
  recalledHoldRef,
  products,
  recentSales,
  onAddProduct,
  onNotesChange,
  onOpenCustomer,
  onOpenPrescription,
  onOpenBatch,
  onStepQty,
  onSetQty,
  onSetDiscount,
  onRemove,
  onClear,
}: TicketProps) {
  const [noteOpen, setNoteOpen] = useState(false);
  const empty = lines.length === 0;

  return (
    <section aria-label="Current sale" className={tcss.ticket}>
      <div className={tcss.ticketHead}>
        <button
          type="button"
          className={`${tcss.partyBtn}${customer ? "" : ` ${tcss.partyBtnEmpty}`}`}
          onClick={onOpenCustomer}
        >
          <span className={`${tcss.partyAvatar}${customer ? ` ${tcss.partyAvatarFilled}` : ""}`} aria-hidden>
            {customer ? initials(customer.fullName) : <IconUser size={16} />}
          </span>
          <span className={tcss.partyText}>
            <span className={tcss.partyName}>{customer ? customer.fullName : "Walk-in customer"}</span>
            <span className={tcss.partySub}>
              {customer ? (customer.phone ?? "Change customer · F2") : "Add customer · F2"}
            </span>
          </span>
        </button>

        <button
          type="button"
          className={`${tcss.chipBtn}${
            prescription ? ` ${tcss.chipBtnOn}` : rxNeededCount > 0 ? ` ${tcss.chipBtnDanger}` : ""
          }`}
          onClick={onOpenPrescription}
        >
          <IconFileText size={16} />
          {prescription
            ? `${prescription.rxNumber} · ${prescription.patientName}`
            : rxNeededCount > 0
              ? `Prescription needed · ${rxNeededCount} item${rxNeededCount === 1 ? "" : "s"}`
              : "Link prescription"}
        </button>

        <button
          type="button"
          className={`${tcss.chipBtn}${notes.trim() ? ` ${tcss.chipBtnOn}` : ""}`}
          onClick={() => setNoteOpen((v) => !v)}
          aria-expanded={noteOpen}
        >
          <IconEdit size={16} />
          {notes.trim() ? "Note added" : "Note"}
        </button>

        <span className={tcss.spacer} />

        {!empty && (
          <>
            <span className={tcss.counts}>
              {recalledHoldRef ? `Recalled ${recalledHoldRef} · ` : ""}
              {totals.itemCount} item{totals.itemCount === 1 ? "" : "s"} · {totals.unitCount} unit
              {totals.unitCount === 1 ? "" : "s"}
            </span>
            <button type="button" className={tcss.clearBtn} onClick={onClear}>
              Clear sale
            </button>
          </>
        )}
      </div>

      {noteOpen && (
        <div className={tcss.notePanel}>
          <input
            className={tcss.noteInput}
            value={notes}
            maxLength={512}
            autoFocus
            placeholder="A note for this sale — it prints on the receipt"
            aria-label="Sale note"
            onChange={(e) => onNotesChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "Escape") {
                e.stopPropagation();
                setNoteOpen(false);
              }
            }}
          />
          <button type="button" className={tcss.smallBtn} onClick={() => setNoteOpen(false)}>
            Done
          </button>
        </div>
      )}

      {empty ? (
        <>
          <div className={tcss.ready}>
            <span className={tcss.readyIcon} aria-hidden>
              <IconBarcodeScan size={34} />
            </span>
            <span className={tcss.readyTitle}>Ready for the next customer</span>
            <span className={tcss.readyHint}>Scan an item, or start typing — the search box always has the cursor.</span>
            <div className={tcss.readyKeys}>
              <span>
                <span className={tcss.kbd}>F2</span> Customer
              </span>
              <span>
                <span className={tcss.kbd}>F3</span> Price check
              </span>
              <span>
                <span className={tcss.kbd}>F7</span> Held sales
              </span>
              <span>
                <span className={tcss.kbd}>?</span> All shortcuts
              </span>
            </div>
          </div>
          <QuickPicks products={products} recentSales={recentSales} rows={2} onAdd={onAddProduct} />
        </>
      ) : (
        <>
          <div className={tcss.cols} aria-hidden>
            <span>Item</span>
            <span className={tcss.center}>Qty</span>
            <span className={tcss.right}>Price</span>
            <span className={tcss.right}>Total</span>
            <span />
          </div>
          <div className={tcss.lines}>
            {lines.map((line) => (
              <TicketLine
                key={line.key}
                line={line}
                scanned={line.key === scannedKey}
                onOpenBatch={onOpenBatch}
                onStepQty={onStepQty}
                onSetQty={onSetQty}
                onSetDiscount={onSetDiscount}
                onRemove={onRemove}
              />
            ))}
          </div>
          <QuickPicks products={products} recentSales={recentSales} rows={1} onAdd={onAddProduct} />
        </>
      )}
    </section>
  );
}

/* ── A finished sale, read only ───────────────────────────── */

/** What was just sold, so the cashier can check it against the bag while giving change. */
export function PosCompletedTicket({ sale }: { sale: SaleReceipt }) {
  const units = sale.items.reduce((n, item) => n + item.qty, 0);
  return (
    <section aria-label="Completed sale" className={tcss.ticket}>
      <div className={tcss.ticketHead}>
        <span className={tcss.ticketTitle}>{sale.invoiceNo}</span>
        <span className={tcss.paidPill}>Paid</span>
        <span className={tcss.counts}>
          {sale.customer?.fullName ?? "Walk-in customer"} · {formatTime(sale.soldAt)} · {sale.seller.fullName}
        </span>
        <span className={tcss.spacer} />
        <span className={tcss.counts}>
          {sale.items.length} item{sale.items.length === 1 ? "" : "s"} · {units} unit{units === 1 ? "" : "s"}
        </span>
      </div>
      <div className={tcss.doneCols} aria-hidden>
        <span>Item</span>
        <span className={tcss.center}>Qty</span>
        <span className={tcss.right}>Price</span>
        <span className={tcss.right}>Total</span>
      </div>
      <div className={tcss.lines}>
        {sale.items.map((item) => {
          const gross = Number(item.unitPrice) * item.qty;
          const discount = Number(item.discountAmount);
          const percent = gross > 0 && discount > 0 ? Math.round((discount / gross) * 100) : 0;
          return (
            <div key={item.id} className={tcss.doneLine}>
              <span className={tcss.doneName}>
                {item.product.name}{" "}
                {percent > 0 && <span className={tcss.discPill}>−{percent}%</span>}
              </span>
              <span className={tcss.center}>{item.qty}</span>
              <span className={tcss.right}>
                {formatAmount(item.qty > 0 ? (gross - discount) / item.qty : item.unitPrice)}
              </span>
              <span className={tcss.doneStrong}>{formatAmount(item.lineTotal)}</span>
            </div>
          );
        })}
      </div>
      <div className={tcss.doneFoot}>
        <span>
          Subtotal <b>{formatAmount(sale.subtotal)}</b>
        </span>
        <span>
          Discounts <b className={tcss.minus}>−{formatAmount(sale.discountTotal)}</b>
        </span>
        <span>
          VAT <b>{formatAmount(sale.taxTotal)}</b>
        </span>
        <span>
          {sale.payments.map((p) => PAYMENT_METHOD_LABELS[p.method]).join(" + ")} · Total{" "}
          <b>{formatMoney(sale.grandTotal)}</b>
        </span>
      </div>
    </section>
  );
}
