"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiJson } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";
import type {
  DebitNoteRow,
  InvoiceDetail,
  InvoiceRow,
  Payables,
  PaymentRow,
  UnbilledDelivery,
} from "../ledger-types";

function qs(params: Record<string, string | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value) search.set(key, value);
  const text = search.toString();
  return text ? `?${text}` : "";
}

/**
 * One loader shape for every ledger list: re-fetches when its path changes, clears when there
 * is no branch, and never throws into the page. A changed user, branch or filter clears the
 * old rows immediately; a refresh of the same scope keeps its rows while revalidating.
 */
function useLedgerList<T>(
  path: string | null,
  fallbackError: string,
  enabled = true,
) {
  const { branchId, user } = useAuth();
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loaded = useRef(false);
  const scope = `${user?.tenantId}:${user?.id}:${branchId}:${path}:${enabled}`;
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++generation.current;
    if (!branchId || !path || !enabled) {
      loaded.current = false;
      setRows([]);
      setLoading(false);
      setError(null);
      return;
    }
    if (!loaded.current) setLoading(true);
    setError(null);
    try {
      const next = await apiJson<T[]>(path);
      if (mine !== generation.current) return;
      setRows(next);
      setLoadedScope(scope);
      loaded.current = true;
    } catch (err) {
      if (mine !== generation.current) return;
      setLoadedScope(scope);
      setError(err instanceof Error ? err.message : fallbackError);
      setRows([]);
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [branchId, path, fallbackError, enabled, scope]);

  useEffect(() => {
    void reload();
    return () => {
      generation.current += 1;
    };
  }, [reload]);

  return {
    rows: loadedScope === scope ? rows : [],
    loading: loading || (!!branchId && enabled && loadedScope !== scope),
    error: loadedScope === scope ? error : null,
    reload,
    hasBranch: !!branchId,
  };
}

export type InvoiceFilters = {
  supplierId?: string;
  status?: string;
  source?: string;
  from?: string;
  to?: string;
  q?: string;
};

export function useInvoices(filters: InvoiceFilters, enabled = true) {
  return useLedgerList<InvoiceRow>(
    `/purchasing/invoices${qs(filters)}`,
    "Failed to load invoices",
    enabled,
  );
}

export function usePayments(
  filters: { supplierId?: string; from?: string; to?: string },
  enabled = true,
) {
  return useLedgerList<PaymentRow>(
    `/purchasing/payments${qs(filters)}`,
    "Failed to load payments",
    enabled,
  );
}

export function useDebitNotes(
  filters: { supplierId?: string; status?: string },
  enabled = true,
) {
  return useLedgerList<DebitNoteRow>(
    `/purchasing/debit-notes${qs(filters)}`,
    "Failed to load debit notes",
    enabled,
  );
}

export function useUnbilledDeliveries(supplierId: string | null) {
  return useLedgerList<UnbilledDelivery>(
    supplierId
      ? `/purchasing/invoices/unbilled-deliveries?supplierId=${supplierId}`
      : null,
    "Failed to load deliveries",
  );
}

export function usePayables(enabled = true) {
  const { branchId } = useAuth();
  const [data, setData] = useState<Payables | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    if (!branchId || !enabled) {
      setData(null);
      setLoading(false);
      return;
    }
    try {
      setData(await apiJson<Payables>("/purchasing/payables"));
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [branchId, enabled]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, loading, reload };
}

export function useInvoiceDetail(id: string | null) {
  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!id) {
      setDetail(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setDetail(await apiJson<InvoiceDetail>(`/purchasing/invoices/${id}`));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load the invoice",
      );
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { detail, loading, error, reload };
}
