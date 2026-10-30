"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { ActionButton } from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import { ApiError } from "@/lib/api-error";
import css from "./stock-draft.module.css";

export type StockDraftRow = {
  rowNumber: number;
  productId: string;
  name: string;
  categoryName: string | null;
  qty: number;
  costPrice: number | null;
  sellingPrice: number;
  batchNo: string;
  expiryDate: string | null;
  postedBatchId?: string;
};
export type StockDraftView = {
  importId: string;
  version: number;
  rows: StockDraftRow[];
  stagedBy: string;
  postedAt: string | null;
};

/** Captured branch headers and cancellation prevent a branch switch from moving an old draft. */
export function StockDraftEditor({
  branchId,
  importId,
  canEditCosts,
  onChanged,
}: {
  branchId: string;
  importId: string;
  canEditCosts: boolean;
  onChanged?: () => void;
}) {
  const [view, setView] = useState<StockDraftView | null>(null);
  const [rows, setRows] = useState<StockDraftRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [category, setCategory] = useState("all");
  const [page, setPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const base = `/products/import/${importId}/stock`;

  useEffect(() => {
    let cancelled = false;
    setView(null);
    setError(null);
    setBusy(true);
    setStale(false);
    setSaved(false);
    apiJson<StockDraftView>(base, { headers: { "x-branch-id": branchId } })
      .then(
        (result) => {
          if (!cancelled) {
            setView(result);
            setRows(result.rows);
            setDirty(false);
          }
        },
        (cause) => {
          if (!cancelled)
            setError(
              cause instanceof Error
                ? cause.message
                : "Couldn't load opening-stock draft.",
            );
        },
      )
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [base, branchId, revision]);

  const editable = Boolean(
    view &&
    !view.postedAt &&
    !view.rows.some((row) => row.postedBatchId) &&
    canEditCosts &&
    view.rows.every((row) => row.costPrice !== null),
  );
  const filtered = rows.filter(
    (row) =>
      category === "all" || JSON.stringify(row.categoryName) === category,
  );
  const groups = [...new Set(rows.map((row) => row.categoryName))];
  const pages = Math.max(1, Math.ceil(filtered.length / 25));

  function edit(rowNumber: number, patch: Partial<StockDraftRow>) {
    setRows((current) =>
      current.map((row) =>
        row.rowNumber === rowNumber ? { ...row, ...patch } : row,
      ),
    );
    setDirty(true);
    setSaved(false);
  }

  async function save() {
    if (!view || !editable || stale) return;
    if (
      rows.some(
        (row) =>
          !Number.isSafeInteger(row.qty) ||
          row.qty < 1 ||
          !row.batchNo.trim() ||
          !Number.isFinite(row.costPrice) ||
          Number(row.costPrice) < 0 ||
          !Number.isFinite(row.sellingPrice) ||
          row.sellingPrice < 0,
      )
    ) {
      setError(
        "Each row needs a positive whole quantity, a batch number and non-negative prices.",
      );
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    const form = new FormData();
    // Document-sized multipart is supported by P1; do not raise global JSON body limits.
    form.append(
      "file",
      new Blob(
        [
          JSON.stringify({
            version: view.version,
            rows: rows.map(({ postedBatchId: _posted, ...row }) => row),
          }),
        ],
        { type: "application/json" },
      ),
      "opening-stock-draft.json",
    );
    try {
      const result = await apiJson<StockDraftView>(`${base}/replace`, {
        method: "POST",
        headers: { "x-branch-id": branchId },
        body: form,
      });
      setView(result);
      setRows(result.rows);
      setSaved(true);
      setDirty(false);
      onChanged?.();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Couldn't save opening-stock draft.",
      );
      if (cause instanceof ApiError && cause.status === 409) setStale(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={css.panel} aria-label="Opening-stock draft">
      <h2>Opening-stock draft</h2>
      <p>
        Review and replace this draft before any of it is posted. Saving the
        draft changes no available stock.
      </p>
      <p>
        Post opening stock at the counter in PharmaCeylon POS, in one action or
        by category using the reviewed version. Desktop posting screens are
        still pending; this page cannot post stock, including during a web-POS
        fallback.
      </p>
      {error ? <Alert variant="error">{error}</Alert> : null}
      {saved ? (
        <p role="status">Draft saved. Available stock has not changed.</p>
      ) : null}
      <ActionButton
        disabled={busy}
        onClick={() => {
          setRevision((value) => value + 1);
          setCategory("all");
          setPage(0);
        }}
      >
        Reload draft{dirty ? " (discard edits)" : ""}
      </ActionButton>
      {stale ? (
        <p>
          Another person changed or posted this draft. Reload and review the
          current version before saving again.
        </p>
      ) : null}
      {view ? (
        <>
          <p>
            Version {view.version} ·{" "}
            {view.rows.filter((row) => row.postedBatchId).length} of{" "}
            {view.rows.length} rows posted ·{" "}
            {view.rows
              .filter((row) => !row.postedBatchId)
              .reduce((sum, row) => sum + row.qty, 0)
              .toLocaleString()}{" "}
            units waiting at the counter.
          </p>
          {view.postedAt ? (
            <p>
              Posting has started. The entire draft is now locked; correct
              posted stock through ordinary counter adjustments.
            </p>
          ) : !editable ? (
            <p>
              Cost access is required to replace a draft. Hidden costs are
              preserved on the server; you can review its quantities and posting
              status here.
            </p>
          ) : null}
          <label>
            Show category{" "}
            <select
              aria-label="Show draft category"
              value={category}
              onChange={(event) => {
                setCategory(event.target.value);
                setPage(0);
              }}
            >
              <option value="all">All categories</option>
              {groups.map((name) => (
                <option key={JSON.stringify(name)} value={JSON.stringify(name)}>
                  {name ?? "Uncategorized"}
                </option>
              ))}
            </select>
          </label>
          <div className={css.scroll}>
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Category</th>
                  <th>Quantity</th>
                  <th>Cost</th>
                  <th>Selling price</th>
                  <th>Batch</th>
                  <th>Expiry</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(page * 25, (page + 1) * 25).map((row) => (
                  <tr key={row.rowNumber}>
                    <td>{row.name}</td>
                    <td>{row.categoryName ?? "Uncategorized"}</td>
                    <td>
                      <input
                        aria-label={`Quantity row ${row.rowNumber}`}
                        type="number"
                        min={1}
                        step={1}
                        disabled={!editable || busy || stale}
                        value={row.qty}
                        onChange={(event) =>
                          edit(row.rowNumber, {
                            qty: Number(event.target.value),
                          })
                        }
                      />
                    </td>
                    <td>
                      {!canEditCosts || row.costPrice === null ? (
                        "Hidden"
                      ) : (
                        <input
                          aria-label={`Cost row ${row.rowNumber}`}
                          type="number"
                          min={0}
                          step="0.01"
                          disabled={!editable || busy || stale}
                          value={row.costPrice}
                          onChange={(event) =>
                            edit(row.rowNumber, {
                              costPrice: Number(event.target.value),
                            })
                          }
                        />
                      )}
                    </td>
                    <td>
                      <input
                        aria-label={`Selling price row ${row.rowNumber}`}
                        type="number"
                        min={0}
                        step="0.01"
                        disabled={!editable || busy || stale}
                        value={row.sellingPrice}
                        onChange={(event) =>
                          edit(row.rowNumber, {
                            sellingPrice: Number(event.target.value),
                          })
                        }
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Batch row ${row.rowNumber}`}
                        maxLength={200}
                        disabled={!editable || busy || stale}
                        value={row.batchNo}
                        onChange={(event) =>
                          edit(row.rowNumber, { batchNo: event.target.value })
                        }
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Expiry row ${row.rowNumber}`}
                        type="date"
                        disabled={!editable || busy || stale}
                        value={row.expiryDate?.slice(0, 10) ?? ""}
                        onChange={(event) =>
                          edit(row.rowNumber, {
                            expiryDate: event.target.value
                              ? `${event.target.value}T00:00:00.000Z`
                              : null,
                          })
                        }
                      />
                    </td>
                    <td>{row.postedBatchId ? "Posted" : "Waiting"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={css.actions}>
            <button
              type="button"
              disabled={page === 0}
              onClick={() => setPage((value) => value - 1)}
            >
              Previous rows
            </button>
            <span>
              Page {Math.min(page + 1, pages)} of {pages}
            </span>
            <button
              type="button"
              disabled={page + 1 >= pages}
              onClick={() => setPage((value) => value + 1)}
            >
              Next rows
            </button>
          </div>
          {editable ? (
            <ActionButton onClick={save} disabled={busy || stale || !dirty}>
              {busy ? "Saving…" : "Save draft changes"}
            </ActionButton>
          ) : null}
        </>
      ) : busy ? (
        <p>Loading draft…</p>
      ) : null}
    </section>
  );
}
