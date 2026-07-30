"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/use-auth";
import { discardHold, listHolds, recallHold } from "../services/pos-api";
import type { HeldSaleDetail, HeldSaleSummary } from "../types";

export function usePosHolds() {
  const { branchId } = useAuth();
  const [holds, setHolds] = useState<HeldSaleSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!branchId) {
      setHolds([]);
      return;
    }
    setLoading(true);
    try {
      setHolds(await listHolds());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load parked sales");
    } finally {
      setLoading(false);
    }
  }, [branchId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * Recall atomically consumes the hold on the server, so it can never come back
   * as a duplicate; drop it from local state immediately rather than waiting on
   * the next `reload()` so the parked list never briefly shows a stale entry.
   */
  const recall = useCallback(async (id: string): Promise<HeldSaleDetail> => {
    const detail = await recallHold(id);
    setHolds((prev) => prev.filter((h) => h.id !== id));
    return detail;
  }, []);

  const discard = useCallback(
    async (id: string) => {
      await discardHold(id);
      setHolds((prev) => prev.filter((h) => h.id !== id));
    },
    [],
  );

  return { holds, loading, error, reload, recall, discard };
}
