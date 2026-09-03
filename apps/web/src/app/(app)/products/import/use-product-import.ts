"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, apiJson } from "@/lib/auth-client";
import { parseApiError } from "@/lib/api-error";
import { createIdempotencyKey } from "@/lib/idempotency";
import type {
  ImportAnalysis,
  ImportJobProgress,
  ImportMapping,
  ImportPreview,
  ImportResult,
  ImportStep,
  ImportSummary,
} from "./types";

const POLL_MS = 700;

async function postFile<T>(
  path: string,
  file: File,
  fields: Record<string, string> = {},
  headers: Record<string, string> = {},
): Promise<T> {
  const form = new FormData();
  form.append("file", file);
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  // No Content-Type header: the browser must set the multipart boundary itself.
  const res = await apiFetch(path, { method: "POST", body: form, headers });
  const text = await res.text();
  if (!res.ok) throw new Error(parseApiError(text, `Request failed (${res.status})`));
  return (text.trim() ? JSON.parse(text) : {}) as T;
}

/**
 * Drives the four-step import: read the file, confirm the column mapping, dry-run, then run it
 * as a job. The file is re-sent at each step rather than parked on the server — an upload that
 * is abandoned half way should leave nothing behind.
 */
export function useProductImport() {
  const [step, setStep] = useState<ImportStep>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null);
  const [mapping, setMapping] = useState<ImportMapping>({});
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [confirmedRows, setConfirmedRows] = useState<Set<number>>(() => new Set());
  const [progress, setProgress] = useState<ImportJobProgress | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<ImportSummary[]>([]);
  const pollRef = useRef<number | null>(null);
  /**
   * Held across retries of the same import, so clicking "Import" again after a network blip
   * replays the original run instead of posting every opening-stock batch a second time.
   * Cleared only when the wizard is reset for a genuinely new file.
   */
  const idempotencyKeyRef = useRef<string | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current != null) {
      window.clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const loadHistory = useCallback(async () => {
    try {
      setHistory(await apiJson<ImportSummary[]>("/products/import/history?take=10"));
    } catch {
      /* History is a convenience — a failure here shouldn't block an import. */
    }
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const chooseFile = useCallback(async (next: File) => {
    setBusy(true);
    setError(null);
    try {
      const data = await postFile<ImportAnalysis>("/products/import/analyze", next);
      setFile(next);
      setAnalysis(data);
      setMapping(data.suggestedMapping);
      setPreview(null);
      setConfirmedRows(new Set());
      setResult(null);
      setProgress(null);
      setStep("map");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't read that file");
      setFile(null);
      setAnalysis(null);
    } finally {
      setBusy(false);
    }
  }, []);

  const setField = useCallback((field: keyof ImportMapping, header: string) => {
    setMapping((prev) => {
      const next = { ...prev };
      if (!header) {
        delete next[field];
        return next;
      }
      // A column can only feed one field — silently mapping it twice would double-write it.
      for (const key of Object.keys(next) as Array<keyof ImportMapping>) {
        if (key !== field && next[key] === header) delete next[key];
      }
      next[field] = header;
      return next;
    });
    setPreview(null);
  }, []);

  const runPreview = useCallback(async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const data = await postFile<ImportPreview>("/products/import/preview", file, {
        mapping: JSON.stringify(mapping),
      });
      setPreview(data);
      setStep("review");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preview failed");
    } finally {
      setBusy(false);
    }
  }, [file, mapping]);

  const poll = useCallback(
    (jobId: string) => {
      const tick = async () => {
        try {
          const data = await apiJson<ImportJobProgress>(
            `/products/import/jobs/${jobId}`,
          );
          setProgress(data);
          if (data.status === "completed") {
            setResult(data.result ?? null);
            setStep("done");
            void loadHistory();
            return;
          }
          if (data.status === "failed") {
            setError(data.error ?? "Import failed");
            setStep("done");
            void loadHistory();
            return;
          }
          pollRef.current = window.setTimeout(() => void tick(), POLL_MS);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Lost track of the import job");
          setStep("done");
        }
      };
      void tick();
    },
    [loadHistory],
  );

  const runImport = useCallback(async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setStep("running");
    idempotencyKeyRef.current ??= createIdempotencyKey(
      "product-import",
      `${file.name}-${file.size}`,
    );
    try {
      const { jobId } = await postFile<{ jobId: string; importId: string }>(
        "/products/import/confirm",
        file,
        {
          mapping: JSON.stringify(mapping),
          confirmedRows: JSON.stringify([...confirmedRows]),
        },
        { "Idempotency-Key": idempotencyKeyRef.current },
      );
      poll(jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed to start");
      setStep("review");
    } finally {
      setBusy(false);
    }
  }, [file, mapping, confirmedRows, poll]);

  const toggleConfirmedRow = useCallback((rowNumber: number) => {
    setConfirmedRows((prev) => {
      const next = new Set(prev);
      if (next.has(rowNumber)) next.delete(rowNumber);
      else next.add(rowNumber);
      return next;
    });
  }, []);

  const confirmAllPending = useCallback(() => {
    setConfirmedRows(new Set((preview?.pendingCompliance ?? []).map((p) => p.rowNumber)));
  }, [preview]);

  const undo = useCallback(
    async (importId: string) => {
      setBusy(true);
      setError(null);
      try {
        await apiJson(`/products/import/${importId}/undo`, { method: "POST" });
        await loadHistory();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't undo that import");
      } finally {
        setBusy(false);
      }
    },
    [loadHistory],
  );

  const reset = useCallback(() => {
    stopPolling();
    setStep("upload");
    setFile(null);
    setAnalysis(null);
    setMapping({});
    setPreview(null);
    setConfirmedRows(new Set());
    setProgress(null);
    setResult(null);
    setError(null);
    idempotencyKeyRef.current = null;
  }, [stopPolling]);

  return {
    step,
    setStep,
    file,
    analysis,
    mapping,
    preview,
    confirmedRows,
    progress,
    result,
    busy,
    error,
    history,
    chooseFile,
    setField,
    runPreview,
    runImport,
    toggleConfirmedRow,
    confirmAllPending,
    undo,
    reset,
    dismissError: () => setError(null),
  };
}
