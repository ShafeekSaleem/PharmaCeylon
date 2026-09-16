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
  /** When true, only batches holding quarantined units. */
  quarantined?: boolean | null;
  includeZero?: boolean;
  controlled?: "controlled" | "regular" | null;
  /** Batch number, product name or SKU — matched by the API. */
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
      if (opts.quarantined === true) params.set("quarantined", "true");
      if (opts.includeZero === false) params.set("includeZero", "false");
      if (opts.controlled) params.set("controlled", opts.controlled);
      if (opts.q?.trim()) params.set("q", opts.q.trim());
      const qs = params.toString();
      setRows(await apiJson<BatchRow[]>(`/inventory/batches${qs ? `?${qs}` : ""}`));
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
    opts.quarantined,
    opts.includeZero,
    opts.controlled,
    opts.q,
  ]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { rows, loading, error, reload, hasBranch: !!branchId };
}
