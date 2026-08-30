"use client";

import Link from "next/link";
import { IconEye, IconBox } from "@/components/icons";
import css from "../catalog.module.css";
import type { CatalogSearchItem, MatchType } from "../types";
import { formatLkr, matchTypeLabel, stockStatusLabel } from "../utils";

type Props = {
  items: CatalogSearchItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  highlightIndex: number;
};

function MatchBadge({ type }: { type: MatchType }) {
  const cls =
    type === "exact"
      ? css.matchExact
      : type === "generic"
        ? css.matchGeneric
        : type === "alias"
          ? css.matchAlias
          : css.matchPartial;
  return <span className={`${css.matchBadge} ${cls}`}>{matchTypeLabel(type)}</span>;
}

function StockPill({ item }: { item: CatalogSearchItem }) {
  if (item.qtyOnHand == null || item.stockStatus == null) {
    return <span className={css.productSub}>—</span>;
  }
  const tone =
    item.stockStatus === "out"
      ? css.stockOut
      : item.stockStatus === "low"
        ? css.stockLow
        : css.stockOk;
  return (
    <span className={`${css.stockPill} ${tone}`}>
      {item.qtyOnHand} · {stockStatusLabel(item.stockStatus)}
    </span>
  );
}

export function ResultsTable({ items, selectedId, onSelect, highlightIndex }: Props) {
  return (
    <div className={css.tableWrap}>
      <table className={css.table}>
        <thead>
          <tr>
            <th>Product</th>
            <th>SKU / Reg.</th>
            <th>Brand</th>
            <th>Form / Schedule</th>
            <th>Match</th>
            <th>Stock</th>
            <th>Price</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => {
            const selected = item.id === selectedId;
            const highlighted = index === highlightIndex;
            return (
              <tr
                key={item.id}
                className={`${css.row}${selected ? ` ${css.rowSelected}` : ""}${
                  highlighted ? ` ${css.rowHighlight}` : ""
                }`}
                onClick={() => onSelect(item.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(item.id);
                  }
                }}
                data-selected={selected ? "true" : undefined}
              >
                <td>
                  <div className={css.productCell}>
                    {item.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={item.imageUrl} alt="" className={css.thumb} />
                    ) : (
                      <div className={`${css.thumb} ${css.thumbPlaceholder}`}>
                        {item.name.slice(0, 2).toUpperCase()}
                      </div>
                    )}
                    <div>
                      <div className={css.productName}>{item.name}</div>
                      <div className={css.productSub}>
                        {item.genericName || "—"}
                        {item.isControlled ? " · Controlled" : ""}
                      </div>
                    </div>
                  </div>
                </td>
                <td className={css.mono}>
                  <div>{item.sku}</div>
                  <div className={css.productSub}>
                    {item.registrationNo && item.registrationNo !== item.sku
                      ? `Reg. ${item.registrationNo}`
                      : item.barcode || "—"}
                  </div>
                </td>
                <td>{item.brandName || "—"}</td>
                <td>
                  <div>
                    {item.dosageForm || "—"}
                    {item.strength ? ` · ${item.strength}` : ""}
                  </div>
                  <div className={css.productSub}>
                    {item.schedule ? `Sch. ${item.schedule}` : "—"}
                  </div>
                </td>
                <td>
                  <MatchBadge type={item.matchType} />
                </td>
                <td>
                  <StockPill item={item} />
                </td>
                <td className={css.mono}>{formatLkr(item.sellPrice)}</td>
                <td>
                  <div className={css.actionsCell} onClick={(e) => e.stopPropagation()}>
                    <Link
                      href={`/products/${item.id}`}
                      className={css.iconBtn}
                      aria-label="View product"
                      data-tooltip="View product"
                    >
                      <IconEye size={16} />
                    </Link>
                    <Link
                      href={`/inventory?productId=${encodeURIComponent(item.id)}`}
                      className={css.iconBtn}
                      aria-label="Inventory"
                      data-tooltip="Inventory"
                    >
                      <IconBox size={16} />
                    </Link>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
