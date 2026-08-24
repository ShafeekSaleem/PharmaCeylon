"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import {
  IconBarcodeScan,
  IconPill,
  IconRotateCcw,
  IconSearch,
  IconShoppingBag,
} from "@/components/icons";
import { PRODUCT_PLACEHOLDER_SRC } from "@/lib/product-placeholder";
import { POS_MODES, SEARCH_RESULT_LIMIT } from "../constants";
import type { PosMode, PosProduct } from "../types";
import { findExactScan, formatMoney, matchesQuery, productSubtitle } from "../utils";
import css from "../pos.module.css";

const MODE_ICONS: Record<PosMode, React.ReactNode> = {
  retail: <IconShoppingBag size={14} />,
  prescription: <IconPill size={14} />,
  returns: <IconRotateCcw size={14} />,
};

type Props = {
  products: PosProduct[];
  mode: PosMode;
  onModeChange: (mode: PosMode) => void;
  onSelect: (product: PosProduct) => void;
  inputRef: RefObject<HTMLInputElement>;
  disabled?: boolean;
  /** Hide product search (e.g. Returns mode uses invoice search instead). */
  searchDisabled?: boolean;
};

/**
 * Barcode-first hero input. An exact barcode/SKU match on Enter drops straight
 * into the cart; anything ambiguous shows a keyboard-navigable picker.
 */
export function PosSearchBar({
  products,
  mode,
  onModeChange,
  onSelect,
  inputRef,
  disabled = false,
  searchDisabled = false,
}: Props) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    const term = query.trim();
    if (!term) return [];
    return products
      .map((product) => ({ product, score: matchesQuery(product, term) }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || a.product.name.localeCompare(b.product.name))
      .slice(0, SEARCH_RESULT_LIMIT)
      .map((row) => row.product);
  }, [products, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    function onClickOutside(event: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  function commit(product: PosProduct) {
    onSelect(product);
    setQuery("");
    setOpen(false);
    inputRef.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (searchDisabled) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (event.key === "Escape") {
      if (query) {
        event.stopPropagation();
        setQuery("");
        setOpen(false);
      }
      return;
    }
    if (event.key !== "Enter") return;

    event.preventDefault();
    const scanned = findExactScan(products, query);
    if (scanned) {
      commit(scanned);
      return;
    }
    const picked = results[activeIndex] ?? results[0];
    if (picked) {
      commit(picked);
      return;
    }
    setOpen(true);
  }

  const inputLocked = disabled || searchDisabled;
  const showMenu = open && !searchDisabled && query.trim().length > 0;

  return (
    <div className={css.searchCard}>
      <div className={css.searchWrap} ref={wrapRef}>
        <IconSearch size={15} className={css.searchIcon} />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          className={`${css.searchInput}${query && !searchDisabled ? ` ${css.searchInputScanning}` : ""}`}
          placeholder={
            searchDisabled
              ? "Switch to Retail Sale or Prescriptions to scan products"
              : "Scan barcode or search product name, generic, SKU…"
          }
          value={searchDisabled ? "" : query}
          autoComplete="off"
          spellCheck={false}
          disabled={inputLocked}
          aria-label="Scan barcode or search products"
          aria-autocomplete="list"
          aria-controls="pos-search-results"
          aria-expanded={showMenu}
          onChange={(e) => {
            if (searchDisabled) return;
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            if (!searchDisabled) setOpen(true);
          }}
          onKeyDown={onKeyDown}
        />
        <span className={css.scanHint}>
          <IconBarcodeScan size={16} />
        </span>

        {showMenu && (
          <div id="pos-search-results" className={css.resultsMenu} role="listbox">
            {results.length === 0 ? (
              <div className={css.resultsEmpty}>
                No sellable stock matches “{query.trim()}” at this branch.
              </div>
            ) : (
              results.map((product, index) => {
                const outOfStock = product.qtyOnHand <= 0;
                return (
                  <button
                    key={product.id}
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    className={[
                      css.resultRow,
                      index === activeIndex ? css.resultRowActive : "",
                      outOfStock ? css.resultRowDisabled : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    disabled={outOfStock}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => commit(product)}
                  >
                    <img
                      src={product.imageUrl ?? PRODUCT_PLACEHOLDER_SRC}
                      alt=""
                      className={css.thumb}
                      aria-hidden
                    />
                    <span className={css.productText}>
                      <span className={css.resultName}>
                        {product.name}
                        {product.isControlled ? (
                          <span className={css.tagControlled}>Ctrl</span>
                        ) : product.requiresPrescription ? (
                          <span className={css.tagRx}>Rx</span>
                        ) : (
                          <span className={css.tagOtc}>OTC</span>
                        )}
                      </span>
                      <span className={css.resultMeta}>{productSubtitle(product)}</span>
                    </span>
                    <span className={css.resultRight}>
                      <span className={css.resultPrice}>
                        {formatMoney(product.batches[0]?.sellingPrice ?? 0)}
                      </span>
                      <span className={css.resultStock}>{product.qtyOnHand} in stock</span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>

      <div className={css.modeGroup} role="tablist" aria-label="POS mode">
        {POS_MODES.map((option) => (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={mode === option.value}
            className={`${css.modeBtn}${mode === option.value ? ` ${css.modeBtnActive}` : ""}`}
            data-tooltip={option.hint}
            onClick={() => onModeChange(option.value)}
          >
            {MODE_ICONS[option.value]}
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
