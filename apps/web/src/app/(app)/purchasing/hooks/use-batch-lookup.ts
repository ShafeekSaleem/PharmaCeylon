"use client";

import { useCallback, useRef, useState } from "react";
import { apiJson } from "@/lib/auth-client";

export type BatchLookup =
  | { exists: false }
  | {
      exists: true;
      batchId: string;
      batchNo: string;
      expiryDate: string;
      /** An imported placeholder expiry nobody has confirmed — the one kind a delivery may correct. */
      needsExpiryReview: boolean;
      onHand: number;
      quarantined: number;
      supplier: { id: string; name: string } | null;
      costPrice: string | null;
      sellingPrice: string;
    };

/**
 * "Do we already have this batch?", asked as the number is typed.
 *
 * A batch number and its expiry are printed together on the pack, so once the number is
 * recognised the expiry is a fact the system holds — worth filling in for the receiver rather
 * than demanding they retype it and refusing the delivery when it differs by a day.
 *
 * Results are cached per product+batch for the life of the form, and a stale reply can never
 * overwrite a newer one: at a receiving door people type fast.
 */
export function useBatchLookup() {
  const [results, setResults] = useState<Record<string, BatchLookup>>({});
  const cache = useRef<Map<string, BatchLookup>>(new Map());
  const inFlight = useRef<Map<string, number>>(new Map());
  const seq = useRef(0);

  const lookup = useCallback(async (productId: string, batchNo: string): Promise<BatchLookup> => {
    const miss: BatchLookup = { exists: false };
    const trimmed = batchNo.trim();
    if (!productId || !trimmed) {
      setResults((prev) => ({ ...prev, [productId]: miss }));
      return miss;
    }
    const key = `${productId}:${trimmed.toLowerCase()}`;
    const cached = cache.current.get(key);
    if (cached) {
      setResults((prev) => ({ ...prev, [productId]: cached }));
      return cached;
    }

    const ticket = ++seq.current;
    inFlight.current.set(productId, ticket);
    try {
      const data = await apiJson<BatchLookup>(
        `/purchasing/batch-lookup?productId=${encodeURIComponent(productId)}&batchNo=${encodeURIComponent(trimmed)}`,
      );
      cache.current.set(key, data);
      // Another keystroke has already asked a newer question; that answer wins.
      if (inFlight.current.get(productId) !== ticket) return miss;
      setResults((prev) => ({ ...prev, [productId]: data }));
      return data;
    } catch {
      // A failed lookup is a missing convenience, never a reason to block a delivery.
      if (inFlight.current.get(productId) === ticket) {
        setResults((prev) => ({ ...prev, [productId]: miss }));
      }
      return miss;
    }
  }, []);

  const reset = useCallback(() => {
    setResults({});
    inFlight.current.clear();
  }, []);

  return { results, lookup, reset };
}
