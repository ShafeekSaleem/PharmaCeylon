"use client";

import { useCallback, useEffect, useState } from "react";
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
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const text = search.toString();
  return text ? `?${text}` : "";
}

/**
 * One loader shape for every ledger list: re-fetches when its path changes, clears when there
 * is no branch, and never throws into the page.
 */
function useLedgerList<T>(path: string | null, fallbackError: string, enabled = true) {
  const { branchId } = useAuth();
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!branchId || !path || !enabled) {
      setRows([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setRows(await apiJson<T[]>(path));
    } catch (err) {
      setError(err instanceof Error ? err.message : fallbackError);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [branchId, path, fallbackError, enabled]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { rows, loading, error, reload, hasBranch: !!branchId };
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

export function usePayments(filters: { supplierId?: string; from?: string; to?: string }, enabled = true) {
  return useLedgerList<PaymentRow>(
    `/purchasing/payments${qs(filters)}`,
    "Failed to load payments",
    enabled,
  );
}

export function useDebitNotes(filters: { supplierId?: string; status?: string }, enabled = true) {
  return useLedgerList<DebitNoteRow>(
    `/purchasing/debit-notes${qs(filters)}`,
    "Failed to load debit notes",
    enabled,
  );
}

export function useUnbilledDeliveries(supplierId: string | null) {
  return useLedgerList<UnbilledDelivery>(
    supplierId ? `/purchasing/invoices/unbilled-deliveries?supplierId=${supplierId}` : null,
    "Failed to load deliveries",
  );
}

export function usePayables(enabled = true) {
  const { branchId } = useAuth();
  const [data, setData] = useState<Payables | null>(null);
  const reload = useCallback(async () => {
    if (!branchId || !enabled) return setData(null);
    try {
      setData(await apiJson<Payables>("/purchasing/payables"));
    } catch {
      setData(null);
    }
  }, [branchId, enabled]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, reload };
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
      setError(err instanceof Error ? err.message : "Failed to load the invoice");
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
