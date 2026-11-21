import { useEffect, useState } from "react";
import {
  fetchCollectedMoneyTotal,
  fetchIncidentNotesTotal,
  fetchPaymentRecoveryTotal,
} from "../services/sales-api";

type QueueCounts = {
  incidentNotes: number | null;
  paymentRecovery: number | null;
  collectedMoney: number | null;
};

/** Queue totals require `tenant.management` on the API (PR #247 review). */
export function useSalesQueueCounts(branchId: string | null, mayManage: boolean): QueueCounts {
  const [counts, setCounts] = useState<QueueCounts>({
    incidentNotes: null,
    paymentRecovery: null,
    collectedMoney: null,
  });

  useEffect(() => {
    if (!branchId || !mayManage) {
      setCounts({ incidentNotes: null, paymentRecovery: null, collectedMoney: null });
      return;
    }
    let cancelled = false;
    void (async () => {
      const [incidentNotes, paymentRecovery, collectedMoney] = await Promise.all([
        fetchIncidentNotesTotal().catch(() => null),
        fetchPaymentRecoveryTotal().catch(() => null),
        fetchCollectedMoneyTotal().catch(() => null),
      ]);
      if (!cancelled) {
        setCounts({ incidentNotes, paymentRecovery, collectedMoney });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [branchId, mayManage]);

  return counts;
}
