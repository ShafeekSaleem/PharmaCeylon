"use client";

import { useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/alert";
import { IconPlus, IconTrash } from "@/components/icons";
import { Modal, ModalButton, ModalFooter } from "@/components/ui";
import type { BatchRow } from "@/app/(app)/inventory/types";
import { apiJson, fetchTenantBranches, type TenantBranch } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";
import { PurchasingSelect } from "../../purchasing/components/purchasing-select";
import css from "../../purchasing/purchasing.module.css";
import type { CreateTransferLine, CreateTransferLinePayload } from "../types";
import { canApproveTransfer, formatDate, todayIsoDate } from "../utils";

type Props = {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
};

type LineErrors = {
  batchId?: string;
  qty?: string;
};

type FieldErrors = {
  toBranchId?: string;
  expectedOn?: string;
  lines?: string;
  lineErrors?: Record<string, LineErrors>;
};

function newLine(): CreateTransferLine {
  return {
    key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    productId: "",
    batchId: "",
    qty: "1",
  };
}

function isCompleteLine(line: CreateTransferLine, batches: Map<string, BatchRow>): boolean {
  const batch = batches.get(line.batchId);
  const qty = Number(line.qty);
  if (!batch || !Number.isInteger(qty) || qty < 1) return false;
  return qty <= batch.availableQty;
}

export function CreateTransferModal({ open, onClose, onCreated }: Props) {
  const { branchId, user } = useAuth();
  const autoApproves = canApproveTransfer(user, branchId);
  const [branches, setBranches] = useState<TenantBranch[]>([]);
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [batchesLoading, setBatchesLoading] = useState(false);
  const [toBranchId, setToBranchId] = useState("");
  const [expectedOn, setExpectedOn] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<CreateTransferLine[]>([newLine()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [touched, setTouched] = useState(false);

  const fromBranch = useMemo(
    () => branches.find((b) => b.id === branchId) ?? null,
    [branches, branchId],
  );

  const batchById = useMemo(() => new Map(batches.map((b) => [b.id, b])), [batches]);

  useEffect(() => {
    if (!open) return;
    setToBranchId("");
    setExpectedOn("");
    setNotes("");
    setLines([newLine()]);
    setError(null);
    setFieldErrors({});
    setTouched(false);
    setSaving(false);
    fetchTenantBranches()
      .then(setBranches)
      .catch(() => setBranches([]));
  }, [open]);

  useEffect(() => {
    if (!open || !branchId) {
      setBatches([]);
      return;
    }
    setBatchesLoading(true);
    apiJson<BatchRow[]>("/inventory/batches?includeZero=false")
      .then(setBatches)
      .catch(() => setBatches([]))
      .finally(() => setBatchesLoading(false));
  }, [open, branchId]);

  const branchOptions = useMemo(
    () =>
      branches
        .filter((b) => b.id !== branchId)
        .map((b) => ({ value: b.id, label: b.name, meta: b.code })),
    [branches, branchId],
  );

  function batchOptionsForLine(currentKey: string) {
    const usedElsewhere = new Set(
      lines.filter((l) => l.key !== currentKey && l.batchId).map((l) => l.batchId),
    );
    return batches
      .filter((b) => b.availableQty > 0 && !usedElsewhere.has(b.id))
      .map((b) => ({
        value: b.id,
        label: `${b.product.sku} — ${b.product.name}`,
        meta: `${b.batchNo} · ${b.availableQty} available · exp ${formatDate(b.expiryDate)}`,
      }));
  }

  const completeLines = useMemo(
    () => lines.filter((line) => isCompleteLine(line, batchById)),
    [lines, batchById],
  );

  const totalUnits = useMemo(
    () => completeLines.reduce((sum, line) => sum + (Number(line.qty) || 0), 0),
    [completeLines],
  );

  function validate(): FieldErrors {
    const next: FieldErrors = {};
    if (!toBranchId) next.toBranchId = "Select a destination branch";
    if (expectedOn) {
      const min = todayIsoDate();
      if (expectedOn < min) next.expectedOn = "Expected date cannot be in the past";
    }
    const lineErrors: Record<string, LineErrors> = {};
    let completeCount = 0;

    for (const line of lines) {
      const blank = !line.batchId && (!line.qty || line.qty === "1");
      if (blank) continue;

      const errs: LineErrors = {};
      const batch = batchById.get(line.batchId);
      const qty = Number(line.qty);

      if (!line.batchId) errs.batchId = "Select a batch";
      if (!Number.isInteger(qty) || qty < 1) errs.qty = "Enter a valid quantity";
      else if (batch && qty > batch.availableQty) {
        errs.qty = `Only ${batch.availableQty} available`;
      }

      if (Object.keys(errs).length > 0) lineErrors[line.key] = errs;
      else completeCount += 1;
    }

    if (completeCount === 0) {
      next.lines = "Add at least one batch line with a valid quantity";
    }
    if (Object.keys(lineErrors).length > 0) next.lineErrors = lineErrors;
    return next;
  }

  const errors = touched ? validate() : fieldErrors;

  function updateLine(key: string, patch: Partial<CreateTransferLine>) {
    setLines((prev) =>
      prev.map((line) => {
        if (line.key !== key) return line;
        const next = { ...line, ...patch };
        if (patch.batchId) {
          const batch = batchById.get(patch.batchId);
          if (batch) {
            next.productId = batch.productId;
            const qty = Number(next.qty);
            if (!Number.isFinite(qty) || qty > batch.availableQty) {
              next.qty = String(Math.min(batch.availableQty, Math.max(1, qty || 1)));
            }
          }
        }
        return next;
      }),
    );
  }

  function clearLineError(key: string, field: keyof LineErrors) {
    setFieldErrors((prev) => {
      if (!prev.lineErrors?.[key]) return prev;
      const { [field]: _removed, ...rest } = prev.lineErrors[key];
      const lineErrors = { ...prev.lineErrors, [key]: rest };
      if (Object.keys(rest).length === 0) delete lineErrors[key];
      return { ...prev, lineErrors: Object.keys(lineErrors).length ? lineErrors : undefined };
    });
  }

  async function handleSubmit() {
    setTouched(true);
    const nextErrors = validate();
    setFieldErrors(nextErrors);
    if (nextErrors.toBranchId || nextErrors.expectedOn || nextErrors.lines || nextErrors.lineErrors) {
      return;
    }

    const payload: CreateTransferLinePayload[] = completeLines.map((line) => ({
      productId: line.productId,
      batchId: line.batchId,
      qty: Number(line.qty),
    }));

    setSaving(true);
    setError(null);
    try {
      await apiJson("/transfers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          toBranchId,
          expectedOn: expectedOn || null,
          notes: notes.trim() || null,
          items: payload,
        }),
      });
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create transfer");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New transfer"
      description={
        autoApproves
          ? "As owner/manager at this branch, this transfer will be ready to ship immediately after create."
          : "Request stock movement from the active branch. A manager or owner at this branch must approve before dispatch."
      }
      size="xl"
      canDismiss={!saving}
      footer={
        <ModalFooter className={css.createFooter}>
          <ModalButton variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </ModalButton>
          <ModalButton
            variant="primary"
            onClick={() => void handleSubmit()}
            loading={saving}
            disabled={saving || batchesLoading || !branchId}
          >
            {autoApproves ? "Create & approve" : "Create transfer"}
          </ModalButton>
        </ModalFooter>
      }
    >
      {error && (
        <Alert variant="error" className={css.modalAlert}>
          {error}
        </Alert>
      )}

      {!branchId && (
        <Alert variant="warning" className={css.modalAlert}>
          Select a branch in the header before creating a transfer.
        </Alert>
      )}

      <section className={css.createSection}>
        <h3 className={css.createSectionTitle}>1. Transfer details</h3>
        <div className={css.createHeaderGrid}>
          <div className={css.field}>
            <span className={css.fieldLabel}>From branch</span>
            <div className={css.input} style={{ display: "flex", alignItems: "center" }}>
              {fromBranch?.name ?? "—"}
            </div>
          </div>
          <PurchasingSelect
            label="To branch"
            required
            value={toBranchId}
            options={branchOptions}
            placeholder="Select destination…"
            searchPlaceholder="Search branches…"
            onChange={(value) => {
              setToBranchId(value);
              setFieldErrors((prev) => ({ ...prev, toBranchId: undefined }));
            }}
            disabled={saving || branchOptions.length === 0}
            error={errors.toBranchId}
          />
          <div className={css.field}>
            <label className={css.fieldLabel} htmlFor="transfer-expected">
              Expected delivery
            </label>
            <input
              id="transfer-expected"
              type="date"
              className={`${css.input} ${errors.expectedOn ? css.inputError : ""}`}
              value={expectedOn}
              min={todayIsoDate()}
              onChange={(e) => {
                setExpectedOn(e.target.value);
                setFieldErrors((prev) => ({ ...prev, expectedOn: undefined }));
              }}
              disabled={saving}
            />
            {errors.expectedOn && <span className={css.fieldError}>{errors.expectedOn}</span>}
          </div>
          <div className={`${css.field} ${css.fullWidth}`}>
            <label className={css.fieldLabel} htmlFor="transfer-notes">
              Notes
            </label>
            <textarea
              id="transfer-notes"
              className={css.textarea}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={saving}
              placeholder="e.g. Urgent restock for weekend sales. Handle cold-chain items with care."
              rows={2}
            />
          </div>
        </div>
      </section>

      <section className={css.createSection}>
        <div className={css.linesHead}>
          <h3 className={css.createSectionTitle}>2. Line items</h3>
          <button
            type="button"
            className={css.actionBtn}
            onClick={() => setLines((prev) => [...prev, newLine()])}
            disabled={saving || batchesLoading}
          >
            <IconPlus size={14} />
            Add line
          </button>
        </div>

        {errors.lines && <p className={css.linesBannerError}>{errors.lines}</p>}

        <div className={css.linesTableWrap}>
          <table className={css.linesTable}>
            <thead>
              <tr>
                <th>#</th>
                <th>Batch / product</th>
                <th>Batch no.</th>
                <th>Expiry</th>
                <th>Available</th>
                <th>Qty</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => {
                const lineErr = errors.lineErrors?.[line.key];
                const batch = line.batchId ? batchById.get(line.batchId) : null;
                return (
                  <tr key={line.key}>
                    <td className={css.lineIndex}>{index + 1}</td>
                    <td style={{ minWidth: 260 }}>
                      <PurchasingSelect
                        label="Batch"
                        hideLabel
                        required
                        value={line.batchId}
                        options={batchOptionsForLine(line.key)}
                        placeholder={batchesLoading ? "Loading stock…" : "Select batch…"}
                        searchPlaceholder="Search SKU, name, or batch…"
                        onChange={(value) => {
                          updateLine(line.key, { batchId: value });
                          clearLineError(line.key, "batchId");
                        }}
                        disabled={batchesLoading || saving}
                        error={lineErr?.batchId}
                        allowClear
                      />
                    </td>
                    <td className={css.skuCell}>{batch?.batchNo ?? "—"}</td>
                    <td className={css.muted}>
                      {batch ? formatDate(batch.expiryDate) : "—"}
                    </td>
                    <td>{batch ? batch.availableQty : "—"}</td>
                    <td style={{ width: 88 }}>
                      <input
                        type="number"
                        min={1}
                        max={batch?.availableQty}
                        step={1}
                        className={`${css.input} ${lineErr?.qty ? css.inputError : ""}`}
                        value={line.qty}
                        onChange={(e) => {
                          updateLine(line.key, { qty: e.target.value });
                          clearLineError(line.key, "qty");
                        }}
                        disabled={saving || !line.batchId}
                        aria-label={`Quantity line ${index + 1}`}
                      />
                      {lineErr?.qty && <span className={css.fieldError}>{lineErr.qty}</span>}
                    </td>
                    <td>
                      <button
                        type="button"
                        className={`${css.actionBtn} ${css.actionBtnDanger} ${css.lineRemove}`}
                        onClick={() =>
                          setLines((prev) =>
                            prev.length <= 1 ? [newLine()] : prev.filter((l) => l.key !== line.key),
                          )
                        }
                        disabled={saving}
                        aria-label={`Remove line ${index + 1}`}
                        data-tooltip="Remove line"
                      >
                        <IconTrash size={15} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {batches.length === 0 && !batchesLoading && branchId && (
          <p className={css.fieldHint}>No batches with stock at this branch.</p>
        )}

        <div className={css.createTotalsBar}>
          <span className={css.currencyNote}>
            Stock stays at the source until the transfer is approved and dispatched.
          </span>
          <div className={css.totalsGrid}>
            <div className={css.totalItem}>
              <span className={css.totalLabel}>Lines</span>
              <span className={css.totalValue}>{completeLines.length}</span>
            </div>
            <div className={css.totalItem}>
              <span className={css.totalLabel}>Total units</span>
              <span className={`${css.totalValue} ${css.totalGrand}`}>{totalUnits}</span>
            </div>
          </div>
        </div>
      </section>
    </Modal>
  );
}
