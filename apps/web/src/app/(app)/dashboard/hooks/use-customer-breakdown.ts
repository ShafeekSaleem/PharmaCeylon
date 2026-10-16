"use client";

import { useEffect, useState } from "react";
import { withBranch } from "@/lib/api-branch";
import { useDashboardRefresh } from "./use-dashboard-refresh";
import { apiJson } from "@/lib/auth-client";

export type CustomerBreakdown = {
  total: number;
  registered: number;
  walkIn: number;
  newCustomers: number;
  repeatCustomers: number;
};

/** Today's counter footfall split by identity (walk-in/registered) and, within
 * registered, by behavior (new/repeat) — see /analytics/customer-breakdown. */
export function useCustomerBreakdown(branchId: string | null | undefined) {
  const refreshVersion = useDashboardRefresh();
  const [failed, setFailed] = useState(false);
  const [data, setData] = useState<CustomerBreakdown | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!branchId) {
      setData(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    void apiJson<CustomerBreakdown>(
      withBranch("/analytics/customer-breakdown", branchId),
    )
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
        if (!cancelled) setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [branchId, refreshVersion]);

  return { data, loading, failed };
}
