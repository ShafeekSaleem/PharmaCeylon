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
 * is no branch, and never throws into the page. A changed user or branch clears the old rows
 * at once, and a late answer from an earlier request is ignored. A search or filter change keeps
 * the rows on screen until the new ones arrive, so the table never blinks; `fresh` says whether
 * the rows answer the current path, for callers that act on them (a payment allocating against
 * one supplier's invoices must not see the previous supplier's).
 */
function useLedgerList<T>(
  path: string | null,
  fallbackError: string,
  enabled = true,
) {
  const { branchId, user } = useAuth();
  const identity = `${user?.tenantId}:${user?.id}:${branchId}`;
  const key = `${identity}:${path}:${enabled}`;
  const active = !!branchId && !!path && enabled;
  const [rows, setRows] = useState<T[]>([]);
  const [error, setError] = useState<string | null>(null);
  // What the rows on hand answer: whose they are, which request, and whether it was a real fetch.
  const [loaded, setLoaded] = useState<{
    identity: string;
    key: string;
    fetched: boolean;
  } | null>(null);
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++generation.current;
    if (!active) {
      setRows([]);
      setError(null);
      setLoaded({ identity, key, fetched: false });
      return;
    }
    setError(null);
    try {
      const next = await apiJson<T[]>(path!);
      if (mine !== generation.current) return;
      setRows(next);
    } catch (err) {
      if (mine !== generation.current) return;
      setError(err instanceof Error ? err.message : fallbackError);
      setRows([]);
    }
    setLoaded({ identity, key, fetched: true });
  }, [active, path, fallbackError, identity, key]);

  useEffect(() => {
    void reload();
    return () => {
      generation.current += 1;
    };
  }, [reload]);

  const mineRows = loaded?.identity === identity;
  return {
    rows: mineRows ? rows : [],
    // Only a first load for this user and branch shows as loading.
    loading: active && !(mineRows && loaded.fetched),
    fresh: loaded?.key === key,
    error: mineRows ? error : null,
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
