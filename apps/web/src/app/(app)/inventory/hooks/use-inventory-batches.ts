"use client";

import { useCallback, useEffect, useState } from "react";
import { apiJson } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";
import type { BatchRow } from "../types";

export function useInventoryBatches(opts: {
  productId?: string | null;
  nearExpiryDays?: number | null;
  /** When true, only expired batches. */
  expired?: boolean | null;
  /**
   * When true, only batches imported without a real expiry date. They carry a far-future
   * placeholder, so they never appear under the near-expiry or expired filters — this is the
   * only way to find them after a migration import.
   */
  needsExpiryReview?: boolean | null;
  includeZero?: boolean;
  controlled?: "controlled" | "regular" | null;
  q?: string;
}) {
  const { branchId } = useAuth();
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!branchId) {
      setRows([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (opts.productId) params.set("productId", opts.productId);
      if (opts.nearExpiryDays != null) {
        params.set("nearExpiryDays", String(opts.nearExpiryDays));
      }
      if (opts.expired === true) params.set("expired", "true");
      if (opts.needsExpiryReview === true) params.set("needsExpiryReview", "true");
      if (opts.includeZero === false) params.set("includeZero", "false");
      if (opts.controlled) params.set("controlled", opts.controlled);
      const qs = params.toString();
      let data = await apiJson<BatchRow[]>(
        `/inventory/batches${qs ? `?${qs}` : ""}`,
      );
      const q = opts.q?.trim().toLowerCase() ?? "";
      if (q) {
        data = data.filter(
          (b) =>
            b.batchNo.toLowerCase().includes(q) ||
            b.product.sku.toLowerCase().includes(q) ||
            b.product.name.toLowerCase().includes(q),
        );
      }
      setRows(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load batches");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [
    branchId,
    opts.productId,
    opts.nearExpiryDays,
    opts.expired,
    opts.needsExpiryReview,
    opts.includeZero,
    opts.controlled,
    opts.q,
  ]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { rows, loading, error, reload, hasBranch: !!branchId };
}
