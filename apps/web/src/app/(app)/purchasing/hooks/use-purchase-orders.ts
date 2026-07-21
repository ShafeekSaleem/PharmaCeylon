"use client";

import { useCallback, useEffect, useState } from "react";
import { apiJson } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";
import type { PurchaseOrderDetail, PurchaseOrderListItem } from "../types";

export function usePurchaseOrders() {
  const { branchId } = useAuth();
  const [rows, setRows] = useState<PurchaseOrderListItem[]>([]);
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
      const data = await apiJson<PurchaseOrderListItem[]>("/purchasing/purchase-orders");
      setRows(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load purchase orders");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [branchId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { rows, loading, error, reload, hasBranch: !!branchId };
}

export function usePurchaseOrderDetail(id: string | null) {
  const { branchId } = useAuth();
  const [detail, setDetail] = useState<PurchaseOrderDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!branchId || !id) {
      setDetail(null);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const data = await apiJson<PurchaseOrderDetail>(`/purchasing/purchase-orders/${id}`);
      setDetail(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load purchase order");
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [branchId, id]);

  useEffect(() => {
    setDetail(null);
    void reload();
  }, [reload]);

  return { detail, loading, error, reload };
}
