"use client";

import { useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/alert";
import { Modal, ModalButton, ModalFooter, StatusBadge } from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import { ConfirmDialog } from "../../products/components/confirm-dialog";
import layoutCss from "../../purchasing/purchasing.module.css";
import type { BatchRow } from "../../inventory/types";
import { LINE_FILTER_OPTIONS } from "../constants";
import type { StocktakeLineFilter, StocktakeListItem } from "../types";
import {
  canCancel,
  canComplete,
  canEditCounts,
  canStart,
  completeBlockers,
  daysUntilExpiry,
  exportStocktakeCsv,
  filterStocktakeLines,
  formatDate,
  formatMoney,
  formatSigned,
  formatStocktakeNo,
  isNearExpiry,
  liveVariance,
  scopeLabel,
  showSystemQty,
} from "../utils";
import scss from "../stocktakes.module.css";

type ConfirmKind = "start" | "complete" | "match" | "cancel" | null;

type Props = {
  stocktake: StocktakeListItem | null;
  canWrite: boolean;
  canManage: boolean;
  onClose: () => void;
  onChanged: (updated?: StocktakeListItem) => void;
};

function syncLocalState(stocktake: StocktakeListItem) {
  const nextCounts: Record<string, string> = {};
  const nextNotes: Record<string, string> = {};
  for (const line of stocktake.lines) {
    nextCounts[line.batchId] =
      line.countedQty != null ? String(line.countedQty) : "";
    nextNotes[line.batchId] = line.note ?? "";
  }
  return { nextCounts, nextNotes };
}

export function StocktakeDetailModal({
  stocktake,
  canWrite,
  canManage,
  onClose,
  onChanged,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [detail, setDetail] = useState<StocktakeListItem | null>(stocktake);
  const [lineFilter, setLineFilter] = useState<StocktakeLineFilter>("all");
  const [lineSearch, setLineSearch] = useState("");
  const [confirmKind, setConfirmKind] = useState<ConfirmKind>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [batchPool, setBatchPool] = useState<BatchRow[]>([]);
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchSearch, setBatchSearch] = useState("");
  const [selectedBatchIds, setSelectedBatchIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    setDetail(stocktake);
    setBusy(false);
    setActionError(null);
    setConfirmKind(null);
    setLineFilter("all");
    setLineSearch("");
    setAddOpen(false);
    setSelectedBatchIds(new Set());
    if (!stocktake) {
      setCounts({});
      setNotes({});
      return;
    }
    const { nextCounts, nextNotes } = syncLocalState(stocktake);
    setCounts(nextCounts);
    setNotes(nextNotes);
  }, [stocktake]);

  const editable = !!detail && canWrite && canEditCounts(detail.status);
  const systemVisible = !!detail && showSystemQty(detail);
  const nearDays = detail?.nearExpiryDays ?? 90;

  const filteredLines = useMemo(() => {
    if (!detail) return [];
    const base = filterStocktakeLines(detail.lines, lineFilter, {
      counts,
      nearExpiryDays: nearDays,
    });
    const q = lineSearch.trim().toLowerCase();
    if (!q) return base;
    return base.filter((line) => {
      const hay = [
        line.product.sku,
        line.product.name,
        line.batch.batchNo,
        line.note ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [detail, lineFilter, counts, nearDays, lineSearch]);

  const hasSavableChanges = useMemo(() => {
    if (!detail) return false;
    return detail.lines.some((line) => {
      const raw = counts[line.batchId]?.trim() ?? "";
      const noteRaw = notes[line.batchId] ?? "";
      const noteChanged = (line.note ?? "") !== noteRaw;
      if (raw === "") {
        return noteChanged && line.countedQty != null;
      }
      const qty = Number(raw);
      if (!Number.isInteger(qty) || qty < 0) return false;
      return line.countedQty !== qty || noteChanged;
    });
  }, [detail, counts, notes]);

  const availableBatches = useMemo(() => {
    if (!detail) return [];
    const existing = new Set(detail.lines.map((l) => l.batchId));
    const q = batchSearch.trim().toLowerCase();
    return batchPool.filter((b) => {
      if (existing.has(b.id)) return false;
      if (!q) return true;
      return (
        b.batchNo.toLowerCase().includes(q) ||
        b.product.sku.toLowerCase().includes(q) ||
        b.product.name.toLowerCase().includes(q)
      );
    });
  }, [batchPool, detail, batchSearch]);

  if (!detail) return null;

  function applyUpdated(updated: StocktakeListItem) {
    setDetail(updated);
    onChanged(updated);
    const { nextCounts, nextNotes } = syncLocalState(updated);
    setCounts(nextCounts);
    setNotes(nextNotes);
  }

  async function runAction(path: string, closeAfter = false) {
    setBusy(true);
    setActionError(null);
    try {
      const updated = await apiJson<StocktakeListItem>(
        `/stocktakes/${detail!.id}/${path}`,
        { method: "POST" },
      );
      applyUpdated(updated);
      setConfirmKind(null);
      if (closeAfter) onClose();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  function buildSavableLines() {
    return detail!.lines
      .map((line) => {
        const raw = counts[line.batchId]?.trim() ?? "";
        if (raw === "") return null;
        const qty = Number(raw);
        if (!Number.isInteger(qty) || qty < 0) return null;
        const note = (notes[line.batchId] ?? "").trim();
        return {
          batchId: line.batchId,
          countedQty: qty,
          note: note || null,
        };
      })
      .filter(
        (x): x is { batchId: string; countedQty: number; note: string | null } =>
          !!x,
      );
  }

  async function persistCounts(): Promise<StocktakeListItem | null> {
    const lines = buildSavableLines();
    if (lines.length === 0) return detail;
    const updated = await apiJson<StocktakeListItem>(
      `/stocktakes/${detail!.id}/lines`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines }),
      },
    );
    applyUpdated(updated);
    return updated;
  }

  async function saveCounts() {
    if (buildSavableLines().length === 0) {
      setActionError("Enter at least one counted quantity to save");
      return;
    }

    setBusy(true);
    setActionError(null);
    try {
      await persistCounts();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to save counts");
    } finally {
      setBusy(false);
    }
  }

  async function requestComplete() {
    setActionError(null);
    setBusy(true);
    try {
      const latest = (await persistCounts()) ?? detail!;
      const nextBlockers = completeBlockers(
        latest,
        Object.fromEntries(
          latest.lines.map((l) => [
            l.batchId,
            l.countedQty != null ? String(l.countedQty) : "",
          ]),
        ),
        Object.fromEntries(latest.lines.map((l) => [l.batchId, l.note ?? ""])),
      );
      if (nextBlockers.length > 0) {
        setActionError(`Cannot complete: ${nextBlockers.join("; ")}`);
        return;
      }
      setConfirmKind("complete");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to save before complete");
    } finally {
      setBusy(false);
    }
  }

  async function removeLine(batchId: string) {
    if (!editable) return;
    setBusy(true);
    setActionError(null);
    try {
      const updated = await apiJson<StocktakeListItem>(
        `/stocktakes/${detail!.id}/lines/remove`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ batchIds: [batchId] }),
        },
      );
      applyUpdated(updated);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to remove line");
    } finally {
      setBusy(false);
    }
  }

  async function openAddLines() {
    setAddOpen(true);
    setBatchSearch("");
    setSelectedBatchIds(new Set());
    setBatchLoading(true);
    setActionError(null);
    try {
      const data = await apiJson<BatchRow[]>("/inventory/batches?includeZero=true");
      setBatchPool(data);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to load batches");
      setBatchPool([]);
    } finally {
      setBatchLoading(false);
    }
  }

  async function submitAddLines() {
    const batchIds = [...selectedBatchIds];
    if (batchIds.length === 0) {
      setActionError("Select at least one batch to add");
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const updated = await apiJson<StocktakeListItem>(
        `/stocktakes/${detail!.id}/lines/add`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ batchIds }),
        },
      );
      applyUpdated(updated);
      setAddOpen(false);
      setSelectedBatchIds(new Set());
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to add lines");
    } finally {
      setBusy(false);
    }
  }

  const showStart = canWrite && canStart(detail.status);
  const showComplete = canManage && canComplete(detail.status);
  const showCancel = canManage && canCancel(detail.status);

  const confirmCopy: Record<
    Exclude<ConfirmKind, null>,
    { title: string; label: string; variant: "danger" | "primary"; body: string }
  > = {
    start: {
      title: "Start stocktake?",
      label: "Start & freeze",
      variant: "primary",
      body: "Starting freezes system quantities for this count. Refresh system qty will still be available while the stocktake is open.",
    },
    complete: {
      title: "Complete stocktake?",
      label: "Complete & post",
      variant: "primary",
      body: "Completing posts inventory variances to the stock ledger. This cannot be undone.",
    },
    match: {
      title: "Match uncounted lines?",
      label: "Match to system",
      variant: "primary",
      body: "Uncounted lines will be set to their current system quantity (zero variance).",
    },
    cancel: {
      title: "Cancel stocktake?",
      label: "Cancel stocktake",
      variant: "danger",
      body: "The stocktake will be abandoned. No inventory variances will be posted.",
    },
  };

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title={formatStocktakeNo(detail)}
        description={`${detail.lineCount} lines · ${scopeLabel(detail.scope)} · ${detail.counter.fullName}`}
        size="xl"
        canDismiss={!busy}
        footer={
          <ModalFooter>
            <ModalButton variant="secondary" onClick={onClose} disabled={busy}>
              Close
            </ModalButton>
            {editable && (
              <ModalButton
                variant="secondary"
                onClick={() => void saveCounts()}
                loading={busy}
                disabled={!hasSavableChanges}
              >
                Save counts
              </ModalButton>
            )}
            {showStart && (
              <ModalButton
                variant="primary"
                onClick={() => setConfirmKind("start")}
                disabled={busy}
              >
                Start
              </ModalButton>
            )}
            {showComplete && (
              <ModalButton
                variant="primary"
                onClick={() => void requestComplete()}
                disabled={busy}
              >
                Complete
              </ModalButton>
            )}
            {showCancel && (
              <ModalButton
                variant="danger"
                onClick={() => setConfirmKind("cancel")}
                disabled={busy}
              >
                Cancel
              </ModalButton>
            )}
          </ModalFooter>
        }
      >
        {actionError && <Alert variant="error">{actionError}</Alert>}

        <div className={scss.metaRow}>
          <span>
            Status <StatusBadge status={detail.status} />
          </span>
          <span>
            Scope <span className={scss.scopeBadge}>{scopeLabel(detail.scope)}</span>
          </span>
          {detail.blindCount && (
            <span className={scss.blindPill}>Blind count</span>
          )}
          <span>
            Created <strong>{formatDate(detail.createdAt)}</strong>
          </span>
          {detail.frozenAt && (
            <span>
              Frozen <strong>{formatDate(detail.frozenAt)}</strong>
            </span>
          )}
          {detail.completer && (
            <span>
              Completed by <strong>{detail.completer.fullName}</strong>
              {detail.completedAt ? ` · ${formatDate(detail.completedAt)}` : ""}
            </span>
          )}
        </div>

        {detail.blindCount && !systemVisible && (
          <div className={scss.blindBanner} role="status">
            Blind count is on — system quantities are hidden until this stocktake is
            completed.
          </div>
        )}

        <div className={scss.summaryStrip}>
          <div className={scss.summaryItem}>
            <span className={scss.summaryLabel}>Progress</span>
            <span className={scss.summaryValue}>{detail.progressPct}%</span>
            <div className={layoutCss.progressTrack} aria-hidden>
              <div
                className={`${layoutCss.progressFill}${
                  detail.progressPct >= 100
                    ? ` ${layoutCss.progressFillDone}`
                    : detail.progressPct > 0
                      ? ` ${layoutCss.progressFillWarn}`
                      : ""
                }`}
                style={{ width: `${detail.progressPct}%` }}
              />
            </div>
          </div>
          <div className={scss.summaryItem}>
            <span className={scss.summaryLabel}>Uncounted</span>
            <span className={scss.summaryValue}>{detail.uncountedLineCount}</span>
          </div>
          <div className={scss.summaryItem}>
            <span className={scss.summaryLabel}>Variance lines</span>
            <span className={scss.summaryValue}>{detail.varianceLineCount}</span>
          </div>
          <div className={scss.summaryItem}>
            <span className={scss.summaryLabel}>Units in / out</span>
            <span className={scss.summaryValue}>
              <span className={scss.variancePos}>
                +{detail.varianceUnitsIn}
              </span>
              {" / "}
              <span className={scss.varianceNeg}>
                −{detail.varianceUnitsOut}
              </span>
            </span>
          </div>
          <div className={scss.summaryItem}>
            <span className={scss.summaryLabel}>Approx. value</span>
            <span className={scss.summaryValue}>
              {formatMoney(detail.varianceValueApprox)}
            </span>
          </div>
        </div>

        {detail.notes && (
          <p className={scss.notesBlock}>
            <strong>Notes · </strong>
            {detail.notes}
          </p>
        )}

        <div className={scss.lineToolbar}>
          <input
            type="search"
            className={scss.lineSearch}
            placeholder="Search SKU, product, batch…"
            value={lineSearch}
            onChange={(e) => setLineSearch(e.target.value)}
          />
          <div className={scss.filterChips} role="group" aria-label="Line filters">
            {LINE_FILTER_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`${scss.filterChip}${
                  lineFilter === opt.value ? ` ${scss.filterChipActive}` : ""
                }`}
                onClick={() => setLineFilter(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className={scss.toolbarActions}>
            {editable && (
              <>
                <ModalButton
                  variant="secondary"
                  onClick={() => void openAddLines()}
                  disabled={busy}
                >
                  Add lines
                </ModalButton>
                <ModalButton
                  variant="secondary"
                  onClick={() => void runAction("refresh-system")}
                  disabled={busy}
                >
                  Refresh system
                </ModalButton>
                <ModalButton
                  variant="secondary"
                  onClick={() => setConfirmKind("match")}
                  disabled={busy || detail.uncountedLineCount === 0}
                >
                  Match uncounted
                </ModalButton>
              </>
            )}
            <ModalButton
              variant="secondary"
              onClick={() => exportStocktakeCsv(detail)}
              disabled={busy || detail.lines.length === 0}
            >
              Export CSV
            </ModalButton>
          </div>
        </div>

        {addOpen && editable && (
          <div className={scss.addLinesPanel}>
            <div className={scss.addLinesHeader}>
              <strong>Add batches</strong>
              <button
                type="button"
                className={scss.linkBtn}
                onClick={() => setAddOpen(false)}
                disabled={busy}
              >
                Close
              </button>
            </div>
            <input
              type="search"
              className={scss.lineSearch}
              placeholder="Filter batches…"
              value={batchSearch}
              onChange={(e) => setBatchSearch(e.target.value)}
            />
            {batchLoading ? (
              <p className={layoutCss.muted}>Loading batches…</p>
            ) : availableBatches.length === 0 ? (
              <p className={layoutCss.muted}>No additional batches available.</p>
            ) : (
              <div className={scss.addLinesList}>
                {availableBatches.slice(0, 80).map((b) => {
                  const checked = selectedBatchIds.has(b.id);
                  return (
                    <label key={b.id} className={scss.addLineRow}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          setSelectedBatchIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(b.id)) next.delete(b.id);
                            else next.add(b.id);
                            return next;
                          });
                        }}
                        disabled={busy}
                      />
                      <span className={scss.productCell}>
                        <span className={scss.productName}>{b.product.name}</span>
                        <span className={scss.productMeta}>
                          {b.product.sku} · Batch {b.batchNo} · On hand {b.qtyOnHand}
                          {b.isQuarantined ? " · Quarantined" : ""}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
            <div className={scss.addLinesFooter}>
              <span className={layoutCss.muted}>
                {selectedBatchIds.size} selected
              </span>
              <ModalButton
                variant="primary"
                onClick={() => void submitAddLines()}
                loading={busy}
                disabled={selectedBatchIds.size === 0}
              >
                Add selected
              </ModalButton>
            </div>
          </div>
        )}

        <div className={scss.linesScroll}>
          <table className={scss.linesTable}>
            <thead>
              <tr>
                <th>Product / batch</th>
                {systemVisible && <th className={scss.num}>System</th>}
                <th className={scss.num}>Counted</th>
                <th className={scss.num}>Variance</th>
                <th>Note</th>
                {editable && <th aria-label="Remove" />}
              </tr>
            </thead>
            <tbody>
              {filteredLines.length === 0 ? (
                <tr>
                  <td
                    colSpan={systemVisible ? (editable ? 6 : 5) : editable ? 5 : 4}
                    className={layoutCss.muted}
                  >
                    {detail.lines.length === 0
                      ? "No lines yet. Add batches or create with auto-seed enabled."
                      : "No lines match this filter."}
                  </td>
                </tr>
              ) : (
                filteredLines.map((line) => {
                  const raw = counts[line.batchId] ?? "";
                  const variance = liveVariance(
                    line.systemQty,
                    raw,
                    line.varianceQty,
                  );
                  const noteRequired = variance != null && variance !== 0;
                  const noteVal = notes[line.batchId] ?? "";
                  const near = isNearExpiry(line.batch.expiryDate, nearDays);
                  const daysLeft = daysUntilExpiry(line.batch.expiryDate);

                  return (
                    <tr key={line.id}>
                      <td>
                        <div className={scss.productCell}>
                          <span className={scss.productName}>{line.product.name}</span>
                          <span className={scss.productMeta}>
                            {line.product.sku} · Batch {line.batch.batchNo} · Exp{" "}
                            {formatDate(line.batch.expiryDate)}
                            {near ? ` (${daysLeft}d)` : ""}
                          </span>
                          <span className={scss.tagRow}>
                            {line.batch.isQuarantined && (
                              <span className={scss.tagQuarantine}>Quarantined</span>
                            )}
                            {near && (
                              <span className={scss.tagNearExpiry}>Near expiry</span>
                            )}
                          </span>
                        </div>
                      </td>
                      {systemVisible && (
                        <td className={scss.num}>{line.systemQty}</td>
                      )}
                      <td className={scss.num}>
                        {editable ? (
                          <input
                            className={scss.countInput}
                            type="number"
                            min={0}
                            step={1}
                            value={raw}
                            disabled={busy}
                            onChange={(e) =>
                              setCounts((prev) => ({
                                ...prev,
                                [line.batchId]: e.target.value,
                              }))
                            }
                          />
                        ) : (
                          line.countedQty ?? "—"
                        )}
                      </td>
                      <td className={scss.num}>
                        {variance == null ? (
                          <span className={scss.varianceZero}>—</span>
                        ) : (
                          <span
                            className={
                              variance > 0
                                ? scss.variancePos
                                : variance < 0
                                  ? scss.varianceNeg
                                  : scss.varianceZero
                            }
                          >
                            {formatSigned(variance)}
                          </span>
                        )}
                      </td>
                      <td>
                        {editable ? (
                          <input
                            className={`${scss.noteInput}${
                              noteRequired && !noteVal.trim()
                                ? ` ${scss.noteInputRequired}`
                                : ""
                            }`}
                            type="text"
                            maxLength={512}
                            placeholder={noteRequired ? "Required for variance" : "Optional"}
                            value={noteVal}
                            disabled={busy}
                            onChange={(e) =>
                              setNotes((prev) => ({
                                ...prev,
                                [line.batchId]: e.target.value,
                              }))
                            }
                          />
                        ) : (
                          <span className={scss.noteReadonly}>
                            {line.note?.trim() || "—"}
                          </span>
                        )}
                      </td>
                      {editable && (
                        <td>
                          <button
                            type="button"
                            className={scss.removeBtn}
                            onClick={() => void removeLine(line.batchId)}
                            disabled={busy}
                            aria-label={`Remove ${line.product.sku} batch ${line.batch.batchNo}`}
                          >
                            ×
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Modal>

      {confirmKind && (
        <ConfirmDialog
          open
          title={confirmCopy[confirmKind].title}
          confirmLabel={confirmCopy[confirmKind].label}
          variant={confirmCopy[confirmKind].variant}
          loading={busy}
          onCancel={() => {
            if (!busy) setConfirmKind(null);
          }}
          onConfirm={() => {
            if (confirmKind === "start") void runAction("start");
            else if (confirmKind === "complete") void runAction("complete", true);
            else if (confirmKind === "match") void runAction("match-uncounted");
            else if (confirmKind === "cancel") void runAction("cancel", true);
          }}
        >
          <p>{confirmCopy[confirmKind].body}</p>
          {confirmKind === "complete" && (
            <ul className={scss.confirmSummary}>
              <li>
                Variance lines: <strong>{detail.varianceLineCount}</strong>
              </li>
              <li>
                Units in / out:{" "}
                <strong>
                  +{detail.varianceUnitsIn} / −{detail.varianceUnitsOut}
                </strong>
              </li>
              <li>
                Net units: <strong>{formatSigned(detail.varianceUnitsNet)}</strong>
              </li>
              <li>
                Approx. value impact:{" "}
                <strong>{formatMoney(detail.varianceValueApprox)}</strong>
              </li>
            </ul>
          )}
        </ConfirmDialog>
      )}
    </>
  );
}
