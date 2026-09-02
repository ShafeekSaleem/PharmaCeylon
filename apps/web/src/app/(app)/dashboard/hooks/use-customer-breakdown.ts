"use client";

import { useEffect, useState } from "react";
import { withBranch } from "@/lib/api-branch";
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
    void apiJson<CustomerBreakdown>(withBranch("/analytics/customer-breakdown", branchId))
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [branchId]);

  return { data, loading };
}
