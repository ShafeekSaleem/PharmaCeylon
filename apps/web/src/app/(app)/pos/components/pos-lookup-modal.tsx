"use client";

import { useEffect, useMemo, useState } from "react";
import { IconSearch } from "@/components/icons";
import { Modal, ModalButton, ModalFooter } from "@/components/ui";
import { SEARCH_RESULT_LIMIT } from "../constants";
import type { PosProduct } from "../types";
import { formatDate, formatMoney, matchesQuery, productSubtitle } from "../utils";
import css from "../pos.module.css";

export type LookupMode = "price" | "manual";

type Props = {
  mode: LookupMode | null;
  products: PosProduct[];
  onClose: () => void;
  /** Manual mode only — adds a line at the entered price and quantity. */
  onAddManual: (product: PosProduct, qty: number, unitPrice: number) => void;
  onAdd: (product: PosProduct) => void;
};

/**
 * Two counter lookups that share one product finder: a read-only price check
 * ("how much is this?" without disturbing the cart) and a manual line entry
 * where the cashier overrides the unit price (damaged pack, agreed discount).
 */
export function PosLookupModal({ mode, products, onClose, onAddManual, onAdd }: Props) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<PosProduct | null>(null);
  const [qty, setQty] = useState("1");
  const [price, setPrice] = useState("");

  useEffect(() => {
    if (mode) return;
    setQuery("");
    setPicked(null);
    setQty("1");
    setPrice("");
  }, [mode]);

  const results = useMemo(() => {
    const term = query.trim();
    if (!term) return [];
    return products
      .map((product) => ({ product, score: matchesQuery(product, term) }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, SEARCH_RESULT_LIMIT)
      .map((row) => row.product);
  }, [products, query]);

  function choose(product: PosProduct) {
    setPicked(product);
    setPrice(product.batches[0]?.sellingPrice ?? "0.00");
  }

  const isManual = mode === "manual";

  return (
    <Modal
      open={mode !== null}
      onClose={onClose}
      title={isManual ? "Manual item" : "Price check"}
      description={
        isManual
          ? "Add a line with an overridden unit price. Stock still moves against the FEFO batch."
          : "Look up a price and stock position without touching the cart."
      }
      size="md"
      footer={
        <ModalFooter>
          <ModalButton onClick={onClose}>Close</ModalButton>
          {picked && (
            <ModalButton
              variant="primary"
              onClick={() => {
                if (isManual) {
                  onAddManual(picked, Math.max(Number(qty) || 1, 1), Math.max(Number(price) || 0, 0));
                } else {
                  onAdd(picked);
                }
                onClose();
              }}
            >
              Add to cart
            </ModalButton>
          )}
        </ModalFooter>
      }
    >
      <div className={css.pickerSearch}>
        <IconSearch size={15} className={css.searchIcon} />
        <input
          className={css.pickerSearchInput}
          placeholder="Scan or search a product…"
          value={query}
          autoFocus
          onChange={(e) => {
            setQuery(e.target.value);
            setPicked(null);
          }}
        />
      </div>

      {picked ? (
        <>
          <div className={`${css.pickerRow} ${css.pickerRowActive}`}>
            <span className={css.pickerRowBody}>
              <span className={css.pickerRowTitle}>{picked.name}</span>
              <span className={css.pickerRowMeta}>{productSubtitle(picked)}</span>
            </span>
            <span className={css.pickerRowRight}>
              <span className={css.resultPrice}>
                {formatMoney(picked.batches[0]?.sellingPrice ?? 0)}
              </span>
              <span className={css.resultStock}>{picked.qtyOnHand} in stock</span>
            </span>
          </div>

          <div className={css.pickerDivider}>Batches</div>
          <div className={css.pickerList}>
            {picked.batches.map((batch) => (
              <div key={batch.id} className={css.pickerRow}>
                <span className={css.pickerRowBody}>
                  <span className={css.pickerRowTitle}>{batch.batchNo}</span>
                  <span className={css.batchRowMeta}>
                    Expires {formatDate(batch.expiryDate)} · {batch.qtyOnHand} on hand
                  </span>
                </span>
                <span className={css.pickerRowRight}>
                  <span className={css.resultPrice}>{formatMoney(batch.sellingPrice)}</span>
                </span>
              </div>
            ))}
          </div>

          {isManual && (
            <div className={css.formGrid} style={{ marginTop: "0.7rem" }}>
              <label className={css.field}>
                <span className={css.fieldLabel}>Quantity</span>
                <input
                  className={css.control}
                  type="number"
                  min={1}
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                />
              </label>
              <label className={css.field}>
                <span className={css.fieldLabel}>Unit price (LKR)</span>
                <input
                  className={css.control}
                  type="number"
                  min={0}
                  step="0.01"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                />
              </label>
            </div>
          )}
        </>
      ) : (
        <div className={css.pickerList}>
          {results.length === 0 ? (
            <p className={css.pickerEmpty}>
              {query.trim() ? "No sellable stock matches that search." : "Start typing to search."}
            </p>
          ) : (
            results.map((product) => (
              <button
                key={product.id}
                type="button"
                className={css.pickerRow}
                onClick={() => choose(product)}
              >
                <span className={css.pickerRowBody}>
                  <span className={css.pickerRowTitle}>{product.name}</span>
                  <span className={css.pickerRowMeta}>{productSubtitle(product)}</span>
                </span>
                <span className={css.pickerRowRight}>
                  <span className={css.resultPrice}>
                    {formatMoney(product.batches[0]?.sellingPrice ?? 0)}
                  </span>
                  <span className={css.resultStock}>{product.qtyOnHand} in stock</span>
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </Modal>
  );
}
