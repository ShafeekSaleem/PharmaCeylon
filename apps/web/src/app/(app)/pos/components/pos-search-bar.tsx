"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { IconSearch } from "@/components/icons";
import { SEARCH_RESULT_LIMIT } from "../constants";
import type { PosProduct } from "../types";
import { findExactScan, formatMoney, matchesQuery } from "../utils";
import { lineSubtitle, ProductTag } from "./pos-ticket";
import tcss from "../till.module.css";

type Props = {
  products: PosProduct[];
  onSelect: (product: PosProduct) => void;
  inputRef: RefObject<HTMLInputElement>;
  disabled?: boolean;
  placeholder?: string;
};

/**
 * The till's scan box. An exact barcode or SKU on Enter goes straight into the sale; anything
 * else lists matches to pick with the arrow keys. It keeps the cursor between sales.
 */
export function PosSearchBar({
  products,
  onSelect,
  inputRef,
  disabled = false,
  placeholder = "Scan a barcode, or type a name, generic or SKU",
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
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
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

  const showMenu = open && query.trim().length > 0;

  return (
    <div className={tcss.searchWrap} ref={wrapRef}>
      <label className={tcss.searchField}>
        <IconSearch size={18} />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          className={tcss.searchInput}
          placeholder={placeholder}
          value={query}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          aria-label="Scan or search products"
          aria-autocomplete="list"
          aria-controls="pos-search-results"
          aria-expanded={showMenu}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        <span className={tcss.kbd}>/</span>
      </label>

      {showMenu && (
        <div id="pos-search-results" className={tcss.results} role="listbox">
          {results.length === 0 ? (
            <div className={tcss.resultsEmpty}>
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
                  className={`${tcss.resultRow}${index === activeIndex ? ` ${tcss.resultRowActive}` : ""}`}
                  disabled={outOfStock}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => commit(product)}
                >
                  <span className={tcss.resultMain}>
                    <span className={tcss.resultName}>
                      {product.name}
                      <ProductTag product={product} />
                    </span>
                    <span className={tcss.resultMeta}>{lineSubtitle(product)}</span>
                  </span>
                  <span className={tcss.resultSide}>
                    <span className={tcss.resultPrice}>
                      {formatMoney(product.batches[0]?.sellingPrice ?? 0)}
                    </span>
                    <span className={tcss.resultStock}>{product.qtyOnHand} in stock</span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
