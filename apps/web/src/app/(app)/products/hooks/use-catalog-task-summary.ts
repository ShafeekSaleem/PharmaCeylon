"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchCatalogTaskSummary, type CatalogTaskSummary } from "../api/catalog-tasks";

/**
 * The Work Queue's headline counts, for the Manage Catalog badge and the Products issue banner.
 *
 * Failure is deliberately silent: this drives a badge and an optional banner, and a pharmacist
 * opening the product list to serve a customer should never be shown an error about a
 * background count. Nothing renders, the page works, and the count reappears next load.
 */
export function useCatalogTaskSummary(enabled = true): {
  summary: CatalogTaskSummary | null;
  loading: boolean;
  reload: () => void;
} {
  const [summary, setSummary] = useState<CatalogTaskSummary | null>(null);
  const [loading, setLoading] = useState(enabled);

  const load = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    try {
      setSummary(await fetchCatalogTaskSummary());
    } catch {
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    void load();
  }, [load]);

  return { summary, loading, reload: () => void load() };
}
