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

export function useSalesQueueCounts(
  branchId: string | null,
  mayViewIncidents: boolean,
  mayViewPaymentRecovery: boolean,
  mayViewCollectedMoney: boolean,
): QueueCounts {
  const [counts, setCounts] = useState<QueueCounts>({
    incidentNotes: null,
    paymentRecovery: null,
    collectedMoney: null,
  });

  useEffect(() => {
    if (!branchId) {
      setCounts({ incidentNotes: null, paymentRecovery: null, collectedMoney: null });
      return;
    }
    let cancelled = false;
    void (async () => {
      const [incidentNotes, paymentRecovery, collectedMoney] = await Promise.all([
        mayViewIncidents
          ? fetchIncidentNotesTotal().catch(() => null)
          : Promise.resolve(null),
        mayViewPaymentRecovery
          ? fetchPaymentRecoveryTotal().catch(() => null)
          : Promise.resolve(null),
        mayViewCollectedMoney
          ? fetchCollectedMoneyTotal().catch(() => null)
          : Promise.resolve(null),
      ]);
      if (!cancelled) {
        setCounts({ incidentNotes, paymentRecovery, collectedMoney });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [branchId, mayViewIncidents, mayViewPaymentRecovery, mayViewCollectedMoney]);

  return counts;
}