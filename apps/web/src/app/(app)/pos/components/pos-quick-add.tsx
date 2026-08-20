"use client";

import { useMemo, useState } from "react";
import { IconPlus, IconSparkles } from "@/components/icons";
import { PRODUCT_PLACEHOLDER_SRC } from "@/lib/product-placeholder";
import { QUICK_ADD_TABS, type QuickAddTab } from "../constants";
import type { PosDepartment, PosProduct, RecentSale, ResolvedCartLine } from "../types";
import { formatMoney, formatTime } from "../utils";
import css from "../pos.module.css";

const CARD_LIMIT = 14;

type Props = {
  tab: QuickAddTab;
  onTabChange: (tab: QuickAddTab) => void;
  products: PosProduct[];
  /** Active COMMERCIAL departments this tenant has enabled — drives the Category tab's chips. */
  departments: PosDepartment[];
  recentSales: RecentSale[];
  cartLines: ResolvedCartLine[];
  onAdd: (product: PosProduct) => void;
  onRepeatSale: (sale: RecentSale) => void;
};

/**
 * "Suggested" ranks catalog items that historically sell alongside what is
 * already in the cart, so combo sales (e.g. antibiotic + probiotic) are one tap.
 */
function suggestFor(
  cartLines: ResolvedCartLine[],
  recentSales: RecentSale[],
  products: PosProduct[],
): PosProduct[] {
  if (cartLines.length === 0) return [];
  const inCart = new Set(cartLines.map((l) => l.productId));
  const score = new Map<string, number>();

  for (const sale of recentSales) {
    if (!sale.productIds.some((id) => inCart.has(id))) continue;
    for (const id of sale.productIds) {
      if (inCart.has(id)) continue;
      score.set(id, (score.get(id) ?? 0) + 1);
    }
  }

  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => products.find((p) => p.id === id))
    .filter((p): p is PosProduct => Boolean(p))
    .slice(0, CARD_LIMIT);
}

export function PosQuickAdd({
  tab,
  onTabChange,
  products,
  departments,
  recentSales,
  cartLines,
  onAdd,
  onRepeatSale,
}: Props) {
  const [selectedDept, setSelectedDept] = useState<string | null>(null);

  const cards = useMemo(() => {
    if (tab === "top") {
      return [...products]
        .sort((a, b) => b.units30d - a.units30d || a.name.localeCompare(b.name))
        .slice(0, CARD_LIMIT);
    }
    if (tab === "frequent") {
      return [...products]
        .sort((a, b) => b.lines90d - a.lines90d || a.name.localeCompare(b.name))
        .slice(0, CARD_LIMIT);
    }
    if (tab === "category") {
      if (!selectedDept) return [];
      return products
        .filter((p) => p.commercialDepartmentId === selectedDept)
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, CARD_LIMIT);
    }
    if (tab === "suggested") {
      return suggestFor(cartLines, recentSales, products);
    }
    return [];
  }, [tab, products, cartLines, recentSales, selectedDept]);

  return (
    <section className={css.card}>
      <div className={css.quickTabs} role="tablist" aria-label="Quick add">
        {QUICK_ADD_TABS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={tab === option.value}
            className={`${css.quickTab}${tab === option.value ? ` ${css.quickTabActive}` : ""}`}
            onClick={() => onTabChange(option.value)}
          >
            {option.value === "suggested" && <IconSparkles size={12} />} {option.label}
            {option.value === "suggested" && (
              <span
                className={css.aiBadge}
                data-tooltip="Suggestions based on items in your cart"
              >
                AI
              </span>
            )}
          </button>
        ))}
      </div>

      {tab === "category" && (
        <div className={css.quickTabs} role="group" aria-label="Department" style={{ marginTop: "-0.25rem" }}>
          {departments.length === 0 ? (
            <p className={css.quickEmpty}>
              No commercial departments enabled yet — turn some on in Settings → Catalog → Categories.
            </p>
          ) : (
            departments.map((dept) => (
              <button
                key={dept.id}
                type="button"
                role="tab"
                aria-selected={selectedDept === dept.id}
                className={`${css.quickTab}${selectedDept === dept.id ? ` ${css.quickTabActive}` : ""}`}
                onClick={() => setSelectedDept((cur) => (cur === dept.id ? null : dept.id))}
              >
                {dept.name}
              </button>
            ))
          )}
        </div>
      )}

      <div className={css.quickStrip}>
        {tab === "recent" ? (
          recentSales.length === 0 ? (
            <p className={css.quickEmpty}>No sales at this branch yet today.</p>
          ) : (
            recentSales.map((sale) => (
              <button
                key={sale.id}
                type="button"
                className={css.recentCard}
                onClick={() => onRepeatSale(sale)}
                data-tooltip="Load these products into the cart"
              >
                <span className={css.recentTop}>
                  <span className={css.recentInvoice}>{sale.invoiceNo}</span>
                  <span className={css.recentTotal}>{formatMoney(sale.grandTotal)}</span>
                </span>
                <span className={css.recentMeta}>
                  {formatTime(sale.soldAt)} · {sale.itemCount} unit
                  {sale.itemCount === 1 ? "" : "s"} · {sale.customerName ?? "Walk-in"}
                </span>
                <span className={css.recentMeta}>{sale.summary}</span>
              </button>
            ))
          )
        ) : cards.length === 0 ? (
          <p className={css.quickEmpty}>
            {tab === "suggested"
              ? "Add an item to the cart to see items that usually sell with it."
              : tab === "category"
                ? selectedDept
                  ? "No sellable stock in this department at this branch."
                  : departments.length > 0
                    ? "Pick a department above to browse its products."
                    : ""
                : "No sellable stock at this branch yet."}
          </p>
        ) : (
          cards.map((product) => {
            const price = product.batches[0]?.sellingPrice ?? "0";
            const low = product.stockStatus !== "ok";
            return (
              <article key={product.id} className={css.quickCard}>
                <img
                  src={product.imageUrl ?? PRODUCT_PLACEHOLDER_SRC}
                  alt=""
                  aria-hidden
                  className={css.quickThumb}
                />
                <span className={css.quickName} title={product.name}>
                  {product.name}
                </span>
                <span className={css.quickPrice}>{formatMoney(price)}</span>
                <span className={`${css.quickStock}${low ? ` ${css.quickStockLow}` : ""}`}>
                  In stock · {product.qtyOnHand} units
                </span>
                <button
                  type="button"
                  className={css.quickAddBtn}
                  onClick={() => onAdd(product)}
                  disabled={product.qtyOnHand <= 0}
                >
                  <IconPlus size={12} />
                  Add
                </button>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}
