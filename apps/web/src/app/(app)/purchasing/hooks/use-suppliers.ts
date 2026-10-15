"use client";

import { useCallback, useEffect, useState, useRef } from "react";
import { apiJson } from "@/lib/auth-client";
import type { SupplierOption } from "../types";

export function useSuppliers() {
  const [rows, setRows] = useState<SupplierOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiJson<(SupplierOption & { status?: string })[]>(
        "/suppliers?status=active",
      );
      setRows(data.filter((s) => s.isActive !== false));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load suppliers");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { rows, loading, error, reload };
}

export type ProductOption = {
  id: string;
  sku: string;
  name: string;
  isActive: boolean;
  /** Units in one purchasing pack; 1 when the pharmacy buys singles. */
  unitsPerPack?: number;
  packLabel?: string | null;
};

/**
 * The products a picker offers. It starts with the first 200 and fetches matches from the
 * server as someone types (`search`), adding them to what it already holds — so in a range of
 * thousands every product can be found, and one already chosen never loses its name.
 */
export function useProductOptions() {
  const [rows, setRows] = useState<ProductOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const merge = useCallback((found: ProductOption[]) => {
    setRows((prev) => {
      const known = new Set(prev.map((p) => p.id));
      const fresh = found.filter((p) => p.isActive !== false && !known.has(p.id));
      return fresh.length ? [...prev, ...fresh] : prev;
    });
  }, []);

  const search = useCallback(
    (query: string) => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
      const q = query.trim();
      if (q.length < 2) return;
      searchTimer.current = setTimeout(() => {
        void apiJson<{ items: ProductOption[] }>(
          `/products?take=50&status=active&rangeStatus=RANGED&q=${encodeURIComponent(q)}`,
        )
          .then((data) => merge(data.items))
          .catch(() => undefined);
      }, 250);
    },
    [merge],
  );

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiJson<{ items: ProductOption[] }>(
        // RANGED only: a purchase-order line picker is a transaction surface, so the
        // imported NMRA registry stays out of it. Receiving stock against a reference
        // product promotes it, which is the intended way in.
        "/products?take=200&status=active&rangeStatus=RANGED",
      );
      setRows(data.items.filter((p) => p.isActive !== false));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load products");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { rows, loading, error, reload, search };
}

export type SupplierPriceRow = {
  id: string;
  product: { id: string; sku: string; name: string; unitsPerPack: number; packLabel: string | null };
  supplierSku: string | null;
  unitsPerPack: number;
  packCost: string | null;
  unitCost: string;
  discountPercent: number;
  lastUnitCost: string | null;
  lastPurchasedAt: string | null;
  /** Set when the last cost paid differs from the agreed one — a price that has crept. */
  priceDrift: string | null;
  notes: string | null;
  updatedAt: string;
};

/**
 * One supplier's agreed prices, keyed by product.
 *
 * Order lines used to start from the last batch cost, which is whatever some branch paid on
 * some day, possibly to a different supplier. Prefilling from the supplier's own list is both
 * more accurate and visible — the line says where the number came from.
 */
export type SupplierPricePrefill = {
  productId: string;
  unitCost: string;
  unitsPerPack: number;
  discountPercent: number;
};

export function useSupplierPrices(supplierId: string | null, enabled = true) {
  const [rows, setRows] = useState<SupplierPricePrefill[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!supplierId || !enabled) {
      setRows([]);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setRows(
        await apiJson<SupplierPricePrefill[]>(
          `/purchasing/supplier-prices?supplierId=${encodeURIComponent(supplierId)}`,
        ),
      );
    } catch (err) {
      // A price list is a convenience; someone without the cost permission simply types the
      // cost instead, so a failure here must never block the order.
      setError(err instanceof Error ? err.message : "Failed to load supplier prices");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [supplierId, enabled]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { rows, loading, error, reload };
}
