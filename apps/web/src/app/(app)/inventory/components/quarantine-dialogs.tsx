"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { FormField, SelectField } from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import { ConfirmDialog } from "../../products/components/confirm-dialog";
import css from "../inventory.module.css";
import type { QuarantineReasonCode } from "../types";
import { formatUnits, QUARANTINE_REASON_OPTIONS } from "../utils";

/** The fields both dialogs need from a batch, whether it came from a list row or the stock sheet. */
export type QuarantineTarget = {
  id: string;
  batchNo: string;
  productName: string;
  /** On hand less what is already held or reserved — expired units included, since holding expired stock is the point. */
  holdableQty: number;
  quarantinedQty: number;
  expired: boolean;
  quarantineReason: string | null;
};

function parseQty(value: string, max: number): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const n = Number(value);
  return n >= 1 && n <= max ? n : null;
}

/**
 * Hold units back from sale and transfer. Takes a quantity, so five damaged boxes don't block
 * the other ninety-five on the same batch; defaults to everything available.
 */
export function QuarantineDialog({
  target,
  onClose,
  onDone,
}: {
  target: QuarantineTarget | null;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [qty, setQty] = useState("");
  const [reasonCode, setReasonCode] = useState<QuarantineReasonCode>("damaged");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    setQty(String(target.holdableQty));
    setReasonCode(target.expired ? "expired" : "damaged");
    setNote("");
    setError(null);
  }, [target]);

  const max = target?.holdableQty ?? 0;
  const parsedQty = parseQty(qty, max);
  const noteRequired = reasonCode === "other";
  const valid = parsedQty != null && (!noteRequired || note.trim().length > 0);

  async function submit() {
    if (!target || !valid) return;
    setBusy(true);
    setError(null);
    try {
      await apiJson(`/inventory/batches/${target.id}/quarantine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ qty: parsedQty, reasonCode, reason: note.trim() || undefined }),
      });
      onDone(`Quarantined ${formatUnits(parsedQty!)} of batch ${target.batchNo}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Quarantine failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConfirmDialog
      open={!!target}
      title="Quarantine stock"
      confirmLabel="Quarantine"
      loading={busy}
      confirmDisabled={!valid || max <= 0}
      onCancel={() => {
        if (!busy) onClose();
      }}
      onConfirm={() => void submit()}
    >
      {target && (
        <>
          <p>
            Hold units of <strong>{target.productName}</strong>, batch <strong>{target.batchNo}</strong>,
            back from sale and transfer. They stay on hand until they are released, written off or
            returned to the supplier.
          </p>
          {max <= 0 ? (
            <Alert variant="info">
              Nothing on this batch is available to quarantine — every unit is already held or reserved
              for a transfer.
            </Alert>
          ) : (
            <div className={css.dialogFields}>
              <FormField
                label="Units to quarantine"
                type="number"
                min={1}
                max={max}
                inputMode="numeric"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                hint={`${formatUnits(max)} available on this batch`}
                error={qty && parsedQty == null ? `Enter a whole number from 1 to ${max}` : undefined}
                required
              />
              <SelectField
                label="Reason"
                value={reasonCode}
                onChange={(value) => setReasonCode(value as QuarantineReasonCode)}
                options={QUARANTINE_REASON_OPTIONS}
              />
              <FormField
                as="textarea"
                label={noteRequired ? "What did you find?" : "Note (optional)"}
                value={note}
                placeholder="e.g. Crushed outer carton, seal intact"
                onChange={(e) => setNote(e.target.value)}
                required={noteRequired}
              />
            </div>
          )}
          {error && <Alert variant="error">{error}</Alert>}
        </>
      )}
    </ConfirmDialog>
  );
}

/** Return held units to sellable stock after inspection. Refused by the API for expired batches. */
export function ReleaseDialog({
  target,
  onClose,
  onDone,
}: {
  target: QuarantineTarget | null;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    setQty(String(target.quarantinedQty));
    setNote("");
    setError(null);
  }, [target]);

  const max = target?.quarantinedQty ?? 0;
  const parsedQty = parseQty(qty, max);

  async function submit() {
    if (!target || parsedQty == null) return;
    setBusy(true);
    setError(null);
    try {
      await apiJson(`/inventory/batches/${target.id}/release-quarantine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ qty: parsedQty, reason: note.trim() || undefined }),
      });
      onDone(`Released ${formatUnits(parsedQty)} of batch ${target.batchNo} back to sellable stock.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Release failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConfirmDialog
      open={!!target}
      title="Release from quarantine"
      confirmLabel="Release"
      variant="primary"
      loading={busy}
      confirmDisabled={parsedQty == null || !!target?.expired}
      onCancel={() => {
        if (!busy) onClose();
      }}
      onConfirm={() => void submit()}
    >
      {target && (
        <>
          <p>
            Return held units of <strong>{target.productName}</strong>, batch{" "}
            <strong>{target.batchNo}</strong>, to sellable stock.
          </p>
          {target.quarantineReason && (
            <p className={css.fieldHint}>Held for: {target.quarantineReason}</p>
          )}
          {target.expired ? (
            <Alert variant="warning">
              This batch has expired. Expired stock can&apos;t go back on sale — write it off or return it
              to the supplier instead.
            </Alert>
          ) : (
            <div className={css.dialogFields}>
              <FormField
                label="Units to release"
                type="number"
                min={1}
                max={max}
                inputMode="numeric"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                hint={`${formatUnits(max)} held on this batch`}
                error={qty && parsedQty == null ? `Enter a whole number from 1 to ${max}` : undefined}
                required
              />
              <FormField
                as="textarea"
                label="Inspection note (optional)"
                value={note}
                placeholder="e.g. Checked packaging and seals — fit for sale"
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
          )}
          {error && <Alert variant="error">{error}</Alert>}
        </>
      )}
    </ConfirmDialog>
  );
}

/** Build a dialog target from a batch row as the API returns it. */
export function quarantineTargetFromBatch(row: {
  id: string;
  batchNo: string;
  qtyOnHand: number;
  quarantinedQty: number;
  reservedQty: number;
  expired: boolean;
  quarantineReason: string | null;
  product: { name: string };
}): QuarantineTarget {
  return {
    id: row.id,
    batchNo: row.batchNo,
    productName: row.product.name,
    holdableQty: Math.max(0, row.qtyOnHand - row.quarantinedQty - row.reservedQty),
    quarantinedQty: row.quarantinedQty,
    expired: row.expired,
    quarantineReason: row.quarantineReason,
  };
}
