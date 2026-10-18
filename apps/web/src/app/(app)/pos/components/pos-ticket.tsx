"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  IconBaby,
  IconBarcodeScan,
  IconChevronDown,
  IconChevronUp,
  IconCoffee,
  IconDroplet,
  IconEdit,
  IconFileText,
  IconFirstAid,
  IconLeaf,
  IconMinus,
  IconPackage,
  IconPill,
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

type PickTab = "fast" | "recent" | "together";

const PICK_TABS: Array<{ value: PickTab; label: string }> = [
  { value: "fast", label: "Fast moving" },
  { value: "recent", label: "Recently sold" },
  { value: "together", label: "Goes together" },
];

/** A pick is one tap, so nothing that stops the sale for a prescription or a pharmacist. */
function pickable(p: PosProduct): boolean {
  return p.qtyOnHand > 0 && !p.isControlled && !p.requiresPrescription;
}

/**
 * The three lists the picks offer, none repeating what is already in the sale:
 * fast movers (units in 30 days, then lines in 90), what sold most recently, and what is usually
 * bought with the items in the cart.
 */
export function quickPickLists(
  products: PosProduct[],
  recentSales: RecentSale[],
  cartIds: Set<string>,
): Record<PickTab, PosProduct[]> {
  const byId = new Map(products.map((p) => [p.id, p]));
  const ok = (p: PosProduct | undefined): p is PosProduct => !!p && pickable(p) && !cartIds.has(p.id);

  const fast = products
    .filter((p) => ok(p) && (p.units30d > 0 || p.lines90d > 0))
    .sort((a, b) => b.units30d - a.units30d || b.lines90d - a.lines90d || a.name.localeCompare(b.name));

  const seen = new Set<string>();
  const recent: PosProduct[] = [];
  for (const sale of recentSales) {
    for (const id of sale.productIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const p = byId.get(id);
      if (ok(p)) recent.push(p);
    }
  }

  // Each cart item votes for its partners, stronger for the ones it sells with most.
  const votes = new Map<string, number>();
  for (const id of cartIds) {
    (byId.get(id)?.pairedWith ?? []).forEach((partner, rank) => {
      votes.set(partner, (votes.get(partner) ?? 0) + (6 - rank));
    });
  }
  const together = [...votes.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => byId.get(id))
    .filter(ok);

  return { fast, recent, together };
}

/** What a product is, as a picture: its photo when it has one, else an icon for its kind. */
function PickThumb({ product }: { product: PosProduct }) {
  if (product.imageUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img className={tcss.pickImg} src={product.imageUrl} alt="" loading="lazy" />;
  }
  const text = `${product.dosageForm ?? ""} ${product.commercialCategoryName ?? ""} ${product.name}`.toLowerCase();
  const [Icon, tone] = /tablet|capsule|caplet|pill|lozenge/.test(text)
    ? [IconPill, tcss.pickToneTeal]
    : /baby|infant|diaper|nappy/.test(text)
      ? [IconBaby, tcss.pickToneInfo]
      : /snack|chocolate|drink|juice|coffee|tea|beverage|biscuit|chips|soft drink|water/.test(text)
        ? [IconCoffee, tcss.pickToneWarn]
        : /bandage|plaster|first aid|sanitiz|thermometer|mask|glove|device/.test(text)
          ? [IconFirstAid, tcss.pickToneInfo]
          : /vitamin|supplement|herbal|ayurved|tonic/.test(text)
            ? [IconLeaf, tcss.pickToneGood]
            : /syrup|suspension|liquid|drop|solution|lotion|shampoo|wash|gel|cream|ointment|oil|soap|clean/.test(text)
              ? [IconDroplet, tcss.pickToneInfo]
              : [IconPackage, tcss.pickToneTeal];
  return (
    <span className={`${tcss.pickIcon} ${tone}`} aria-hidden>
      <Icon size={18} />
    </span>
  );
}

function QuickPicks({
  products,
  recentSales,
  cartIds,
  rows,
  collapsed,
  onToggle,
  onAdd,
}: {
  products: PosProduct[];
  recentSales: RecentSale[];
  cartIds: Set<string>;
  rows: 1 | 2;
  /** Folded to its header — the cart has grown and needs the room. */
  collapsed: boolean;
  /** Fold or unfold; null when the picks can't be folded (an empty sale). */
  onToggle: (() => void) | null;
  onAdd: (product: PosProduct) => void;
}) {
  // null = choose for the cashier: what goes with the cart once there is one, else fast movers.
  const [chosen, setChosen] = useState<PickTab | null>(null);
  const lists = useMemo(() => quickPickLists(products, recentSales, cartIds), [products, recentSales, cartIds]);
  const tab: PickTab = chosen ?? (cartIds.size > 0 && lists.together.length > 0 ? "together" : "fast");
  const picks = lists[tab].slice(0, rows * 5);
  if (lists.fast.length === 0 && lists.recent.length === 0) return null;

  return (
    <div className={`${tcss.picks}${collapsed ? ` ${tcss.picksCollapsed}` : ""}`}>
      <div className={tcss.picksHead}>
        <span className={tcss.label}>Quick picks</span>
        {!collapsed && (
          <div className={tcss.pickTabs} role="tablist" aria-label="Quick picks">
            {PICK_TABS.map((t) => {
              const off = t.value === "together" && cartIds.size === 0;
              return (
                <button
                  key={t.value}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.value}
                  disabled={off}
                  data-tooltip={off ? "Add an item to see what usually goes with it" : undefined}
                  className={`${tcss.pickTab}${tab === t.value ? ` ${tcss.pickTabOn}` : ""}`}
                  onClick={() => setChosen(t.value)}
                >
                  {t.label}
                  {t.value === "together" && lists.together.length > 0 && (
                    <span className={tcss.pickTabCount}>{lists.together.length}</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
        <span className={tcss.spacer} />
        {onToggle && (
          <button type="button" className={tcss.linkBtn} onClick={onToggle} aria-expanded={!collapsed}>
            {collapsed ? (
              <>
                Show <IconChevronUp size={14} />
              </>
            ) : (
              <>
                Hide <IconChevronDown size={14} />
              </>
            )}
          </button>
        )}
      </div>
      {!collapsed &&
        (picks.length === 0 ? (
          <span className={tcss.picksEmpty}>
            {tab === "together"
              ? "Nothing usually goes with these items yet."
              : tab === "recent"
                ? "Nothing sold recently that isn't already in the sale."
                : "No fast movers to suggest yet."}
          </span>
        ) : (
          <div className={`${tcss.picksGrid} ${rows === 1 ? tcss.picksOneRow : tcss.picksTwoRows}`}>
            {picks.map((product) => {
              const low = product.stockStatus !== "ok";
              return (
                <button
                  key={product.id}
                  type="button"
                  className={tcss.pick}
                  onClick={() => onAdd(product)}
                  data-tooltip={`${product.name} · ${product.qtyOnHand} in stock`}
                >
                  <PickThumb product={product} />
                  <span className={tcss.pickText}>
                    <span className={tcss.pickName}>{product.name}</span>
                    <span className={tcss.pickPrice}>
                      {formatAmount(product.batches[0]?.sellingPrice ?? 0)}
                      {low && <span className={tcss.pickLow}> · {product.qtyOnHand} left</span>}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        ))}
    </div>
  );
}

/* ── One line ─────────────────────────────────────────────── */

/** The chips a cashier can tap: the usual steps up to their limit, and the limit itself. */
function discountSteps(limit: number): number[] {
  const steps = DISCOUNT_STEPS.filter((step) => step <= limit);
  if (limit > 0 && limit < 100 && !steps.includes(limit)) steps.push(limit);
  return steps.slice(-4);
}

function DiscountEditor({
  line,
  limit,
  onSetDiscount,
  onClose,
}: {
  line: ResolvedCartLine;
  /** The most this person may give; null when they may give any discount. */
  limit: number | null;
  onSetDiscount: (key: string, percent: number) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState(line.discountPercent ? String(line.discountPercent) : "");
  const max = limit ?? 100;
  const steps = limit === null ? DISCOUNT_STEPS : discountSteps(limit);

  useEffect(() => {
    function onDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  function apply(percent: number) {
    const clamped = Math.min(Math.max(Number.isFinite(percent) ? percent : 0, 0), max);
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
            max={max}
            step={1}
            inputMode="decimal"
            placeholder="0"
            autoFocus
            disabled={max <= 0}
            value={value}
            onChange={(e) => {
              const typed = Number(e.target.value) || 0;
              // Over the limit, the field shows the limit rather than a number that won't be applied.
              setValue(typed > max ? String(max) : e.target.value);
              onSetDiscount(line.key, Math.min(Math.max(typed, 0), max));
            }}
            onFocus={(e) => e.currentTarget.select()}
          />
          %
        </span>
      </div>
      {limit !== null && (
        <span className={tcss.popoverNote}>
          {limit > 0 ? `Up to ${limit}% at the till.` : "Discounts aren't allowed at the till."} A manager can give
          more.
        </span>
      )}
      <div className={tcss.popoverChips}>
        {steps.map((step) => (
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
  discountLimit,
  onOpenBatch,
  onStepQty,
  onSetQty,
  onSetDiscount,
  onRemove,
}: {
  line: ResolvedCartLine;
  scanned: boolean;
  discountLimit: number | null;
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
            data-tooltip="Change batch — the soonest expiry is picked first"
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
          <DiscountEditor line={line} limit={discountLimit} onSetDiscount={onSetDiscount} onClose={() => setEditingDiscount(false)} />
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
  /** The most this person may discount a line, in percent; null when there is no limit. */
  discountLimit: number | null;
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
  discountLimit,
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
  const cartIds = useMemo(() => new Set(lines.map((line) => line.productId)), [lines]);
  // null = automatic: picks fold away once the sale has four lines and needs the room.
  const [picksOpen, setPicksOpen] = useState<boolean | null>(null);
  useEffect(() => {
    if (empty) setPicksOpen(null);
  }, [empty]);
  const picksCollapsed = !(picksOpen ?? lines.length < 4);

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
          <QuickPicks
            products={products}
            recentSales={recentSales}
            cartIds={cartIds}
            rows={2}
            collapsed={false}
            onToggle={null}
            onAdd={onAddProduct}
          />
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
                discountLimit={discountLimit}
                onOpenBatch={onOpenBatch}
                onStepQty={onStepQty}
                onSetQty={onSetQty}
                onSetDiscount={onSetDiscount}
                onRemove={onRemove}
              />
            ))}
          </div>
          <QuickPicks
            products={products}
            recentSales={recentSales}
            cartIds={cartIds}
            rows={1}
            collapsed={picksCollapsed}
            onToggle={() => setPicksOpen(picksCollapsed)}
            onAdd={onAddProduct}
          />
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
          Discounts{" "}
          <b className={Number(sale.discountTotal) > 0 ? tcss.minus : undefined}>
            {Number(sale.discountTotal) > 0 ? "−" : ""}
            {formatAmount(sale.discountTotal)}
          </b>
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
