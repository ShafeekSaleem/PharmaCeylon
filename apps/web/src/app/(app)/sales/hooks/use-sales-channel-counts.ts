"use client";

import { useEffect, useRef, useState } from "react";
import { fetchSalesChannelCounts, type SaleChannelCounts } from "../services/sales-api";
import type { SalesFilters } from "../types";

const EMPTY_COUNTS: SaleChannelCounts = {
  all: null,
  desktop_online: null,
  offline: null,
  web_legacy: null,
  fallback: null,
};

/** Totals for each channel chip; panel filters apply, the active channel chip does not. */
export function useSalesChannelCounts(filters: SalesFilters, branchId: string | null) {
  const [counts, setCounts] = useState<SaleChannelCounts>(EMPTY_COUNTS);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    void fetchSalesChannelCounts(filters).then((next) => {
      if (requestId !== requestIdRef.current) return;
      setCounts(next);
    });
    return () => {
      requestIdRef.current++;
    };
  }, [
    branchId,
    filters.from,
    filters.to,
    filters.soldBy,
    filters.paymentMethod,
    filters.invoiceNo,
    filters.receiptCounterScope,
    filters.registerId,
    filters.tillId,
    filters.shiftId,
  ]);

  return counts;
}