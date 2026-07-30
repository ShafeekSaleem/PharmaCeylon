"use client";

import { useCallback, useMemo, useState } from "react";
import type {
  CartLine,
  CartTotals,
  PosBatch,
  PosProduct,
  ResolvedCartLine,
} from "../types";
import { makeLineKey, pickFefoBatch, resolveLine, round2 } from "../utils";

export type AddResult =
  | { status: "added"; key: string }
  | { status: "coalesced"; key: string }
  | { status: "capped"; key: string; available: number }
  | { status: "no-stock" };

const EMPTY_TOTALS: CartTotals = {
  itemCount: 0,
  unitCount: 0,
  subtotal: 0,
  discountTotal: 0,
  taxTotal: 0,
  grandTotal: 0,
};

/**
 * Cart state for the counter. Scanning the same product twice bumps quantity
 * instead of stacking duplicate rows, and every quantity is clamped to the
 * batch's on-hand stock so a cashier can never oversell.
 */
export function usePosCart(
  productsById: Map<string, PosProduct>,
  vatRatePercent: number,
) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [lastTouchedKey, setLastTouchedKey] = useState<string | null>(null);
  /** Bumped only by `addProduct`, so the UI can flash a row per scan. */
  const [addCount, setAddCount] = useState(0);

  const addProduct = useCallback(
    (product: PosProduct, qty = 1, batchOverride?: PosBatch): AddResult => {
      const batch = batchOverride ?? pickFefoBatch(product, qty);
      if (!batch || batch.qtyOnHand <= 0) return { status: "no-stock" };

      const key = makeLineKey(product.id, batch.id);
      let result: AddResult = { status: "added", key };

      setLines((prev) => {
        const existing = prev.find((l) => l.key === key);
        if (existing) {
          const wanted = existing.qty + qty;
          const next = Math.min(wanted, batch.qtyOnHand);
          result =
            next < wanted
              ? { status: "capped", key, available: batch.qtyOnHand }
              : { status: "coalesced", key };
          return prev.map((l) => (l.key === key ? { ...l, qty: next } : l));
        }

        const next = Math.min(qty, batch.qtyOnHand);
        result =
          next < qty ? { status: "capped", key, available: batch.qtyOnHand } : { status: "added", key };
        return [
          ...prev,
          {
            key,
            productId: product.id,
            batchId: batch.id,
            qty: next,
            unitPrice: Number(batch.sellingPrice),
            discountPercent: 0,
            addedAt: Date.now(),
          },
        ];
      });

      setLastTouchedKey(key);
      setAddCount((n) => n + 1);
      return result;
    },
    [],
  );

  const setQty = useCallback(
    (key: string, qty: number) => {
      setLines((prev) =>
        prev.flatMap((line) => {
          if (line.key !== key) return [line];
          if (qty <= 0) return [];
          const product = productsById.get(line.productId);
          const batch = product?.batches.find((b) => b.id === line.batchId);
          const max = batch?.qtyOnHand ?? qty;
          return [{ ...line, qty: Math.min(qty, max) }];
        }),
      );
      setLastTouchedKey(key);
    },
    [productsById],
  );

  const stepQty = useCallback(
    (key: string, delta: number) => {
      setLines((prev) =>
        prev.flatMap((line) => {
          if (line.key !== key) return [line];
          const next = line.qty + delta;
          if (next <= 0) return [];
          const product = productsById.get(line.productId);
          const batch = product?.batches.find((b) => b.id === line.batchId);
          const max = batch?.qtyOnHand ?? next;
          return [{ ...line, qty: Math.min(next, max) }];
        }),
      );
      setLastTouchedKey(key);
    },
    [productsById],
  );

  const setDiscountPercent = useCallback((key: string, percent: number) => {
    const clamped = Math.min(Math.max(percent, 0), 100);
    setLines((prev) =>
      prev.map((line) => (line.key === key ? { ...line, discountPercent: clamped } : line)),
    );
    setLastTouchedKey(key);
  }, []);

  const setUnitPrice = useCallback((key: string, price: number) => {
    const clamped = Math.max(price, 0);
    setLines((prev) =>
      prev.map((line) => (line.key === key ? { ...line, unitPrice: clamped } : line)),
    );
    setLastTouchedKey(key);
  }, []);

  /** Swap a line onto a different batch, merging if that batch is already in the cart. */
  const changeBatch = useCallback((key: string, batch: PosBatch, productId: string) => {
    const nextKey = makeLineKey(productId, batch.id);
    setLines((prev) => {
      const source = prev.find((l) => l.key === key);
      if (!source) return prev;
      const target = prev.find((l) => l.key === nextKey && l.key !== key);
      if (target) {
        return prev
          .filter((l) => l.key !== key)
          .map((l) =>
            l.key === nextKey
              ? { ...l, qty: Math.min(l.qty + source.qty, batch.qtyOnHand) }
              : l,
          );
      }
      return prev.map((l) =>
        l.key === key
          ? {
              ...l,
              key: nextKey,
              batchId: batch.id,
              qty: Math.min(l.qty, batch.qtyOnHand),
              unitPrice: Number(batch.sellingPrice),
            }
          : l,
      );
    });
    setLastTouchedKey(nextKey);
  }, []);

  const removeLine = useCallback((key: string) => {
    setLines((prev) => prev.filter((l) => l.key !== key));
    setLastTouchedKey(null);
  }, []);

  const clear = useCallback(() => {
    setLines([]);
    setLastTouchedKey(null);
  }, []);

  const replaceAll = useCallback((next: CartLine[]) => {
    setLines(next);
    setLastTouchedKey(null);
  }, []);

  const { resolved, unresolvedCount } = useMemo(() => {
    const out: ResolvedCartLine[] = [];
    let missing = 0;
    for (const line of lines) {
      const product = productsById.get(line.productId);
      const batch = product?.batches.find((b) => b.id === line.batchId);
      if (!product || !batch) {
        missing += 1;
        continue;
      }
      out.push(resolveLine(line, product, batch, vatRatePercent));
    }
    return { resolved: out, unresolvedCount: missing };
  }, [lines, productsById, vatRatePercent]);

  const totals = useMemo<CartTotals>(() => {
    if (resolved.length === 0) return EMPTY_TOTALS;
    let subtotal = 0;
    let discountTotal = 0;
    let taxTotal = 0;
    let grandTotal = 0;
    let unitCount = 0;
    for (const line of resolved) {
      subtotal += line.gross;
      discountTotal += line.discountAmount;
      taxTotal += line.taxAmount;
      grandTotal += line.lineTotal;
      unitCount += line.qty;
    }
    return {
      itemCount: resolved.length,
      unitCount,
      subtotal: round2(subtotal),
      discountTotal: round2(discountTotal),
      taxTotal: round2(taxTotal),
      grandTotal: round2(grandTotal),
    };
  }, [resolved]);

  return {
    lines,
    resolved,
    totals,
    unresolvedCount,
    lastTouchedKey,
    addCount,
    isEmpty: lines.length === 0,
    addProduct,
    setQty,
    stepQty,
    setDiscountPercent,
    setUnitPrice,
    changeBatch,
    removeLine,
    clear,
    replaceAll,
  };
}
