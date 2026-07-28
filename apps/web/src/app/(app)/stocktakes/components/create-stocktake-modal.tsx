"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { Modal, ModalButton, ModalFooter } from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";
import css from "../../purchasing/purchasing.module.css";
import { PurchasingSelect } from "../../purchasing/components/purchasing-select";
import {
  MOVEMENT_MODE_OPTIONS,
  DEFAULT_NEAR_EXPIRY_DAYS,
  NEAR_EXPIRY_PRESETS,
  SCOPE_OPTIONS,
} from "../constants";
import type { StocktakeMovementMode, StocktakeScope } from "../types";
import scss from "../stocktakes.module.css";

type Props = {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
};

function toIsoOrNull(localValue: string): string | null {
  const trimmed = localValue.trim();
  if (!trimmed) return null;
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function CreateStocktakeModal({ open, onClose, onCreated }: Props) {
  const { user } = useAuth();
  const [title, setTitle] = useState("");
  const [areaLabel, setAreaLabel] = useState("");
  const [notes, setNotes] = useState("");
  const [seedLines, setSeedLines] = useState(true);
  const [blindCount, setBlindCount] = useState(false);
  const [scope, setScope] = useState<StocktakeScope>("full");
  const [movementMode, setMovementMode] =
    useState<StocktakeMovementMode>("continue_and_reconcile");
  const [nearExpiryDays, setNearExpiryDays] = useState(DEFAULT_NEAR_EXPIRY_DAYS);
  const [scheduledFor, setScheduledFor] = useState("");
  const [expectedCompletionAt, setExpectedCompletionAt] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setAreaLabel("");
    setNotes("");
    setSeedLines(true);
    setBlindCount(false);
    setScope("full");
    setMovementMode("continue_and_reconcile");
    setNearExpiryDays(DEFAULT_NEAR_EXPIRY_DAYS);
    setScheduledFor("");
    setExpectedCompletionAt("");
    setError(null);
    setSaving(false);
  }, [open]);

  useEffect(() => {
    if (scope === "custom") setSeedLines(false);
  }, [scope]);

  async function submit() {
    if (scope === "near_expiry") {
      const days = Number(nearExpiryDays);
      if (!Number.isInteger(days) || days < 1 || days > 730) {
        setError("Near-expiry days must be an integer between 1 and 730.");
        return;
      }
    }

    const scheduledIso = toIsoOrNull(scheduledFor);
    const expectedIso = toIsoOrNull(expectedCompletionAt);
    if (scheduledFor && !scheduledIso) {
      setError("Scheduled date and time is invalid.");
      return;
    }
    if (expectedCompletionAt && !expectedIso) {
      setError("Expected completion date and time is invalid.");
      return;
    }
    if (scheduledIso && expectedIso && new Date(expectedIso) < new Date(scheduledIso)) {
      setError("Expected completion must be after the scheduled time.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        title: title.trim() || null,
        areaLabel: areaLabel.trim() || null,
        notes: notes.trim() || null,
        seedLines: scope === "custom" ? false : seedLines,
        scope,
        blindCount,
        movementMode,
        scheduledFor: scheduledIso,
        expectedCompletionAt: expectedIso,
        counterIds: user?.id ? [user.id] : [],
      };
      if (scope === "near_expiry") {
        body.nearExpiryDays = Number(nearExpiryDays);
      }

      await apiJson<{ id: string }>("/stocktakes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create stocktake");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New stocktake"
      description="Pick a scope and schedule. You can count, review variances, and post from the workspace."
      size="lg"
      canDismiss={!saving}
      footer={
        <ModalFooter>
          <ModalButton variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </ModalButton>
          <ModalButton variant="primary" onClick={() => void submit()} loading={saving}>
            Create stocktake
          </ModalButton>
        </ModalFooter>
      }
    >
      {error ? (
        <div className={css.modalAlert}>
          <Alert variant="error">{error}</Alert>
        </div>
      ) : null}

      <section className={css.createSection}>
        <h3 className={css.createSectionTitle}>Scope</h3>
        <fieldset className={scss.scopeFieldset}>
          <legend className={css.fieldLabel}>What should be counted?</legend>
          <div className={scss.scopeGrid}>
            {SCOPE_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className={`${scss.scopeOption}${scope === opt.value ? ` ${scss.scopeOptionActive}` : ""}`}
              >
                <input
                  type="radio"
                  name="stocktake-scope"
                  value={opt.value}
                  checked={scope === opt.value}
                  onChange={() => setScope(opt.value)}
                  disabled={saving}
                />
                <span className={scss.scopeOptionBody}>
                  <span className={scss.scopeOptionLabel}>{opt.label}</span>
                  <span className={scss.scopeOptionDesc}>{opt.description}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {scope === "near_expiry" ? (
          <div className={css.field} style={{ marginTop: "0.85rem" }}>
            <label className={css.fieldLabel} htmlFor="stocktake-near-days">
              Near-expiry window (days)
            </label>
            <div className={scss.nearDaysRow}>
              <input
                id="stocktake-near-days"
                className={css.input}
                type="number"
                min={1}
                max={730}
                step={1}
                value={nearExpiryDays}
                onChange={(e) => setNearExpiryDays(Number(e.target.value))}
                disabled={saving}
              />
              <div className={scss.filterChips}>
                {NEAR_EXPIRY_PRESETS.map((days) => (
                  <button
                    key={days}
                    type="button"
                    className={`${scss.filterChip}${
                      nearExpiryDays === days ? ` ${scss.filterChipActive}` : ""
                    }`}
                    onClick={() => setNearExpiryDays(days)}
                    disabled={saving}
                  >
                    {days}d
                  </button>
                ))}
              </div>
            </div>
            <p className={css.fieldHint}>Only batches expiring within this window are seeded.</p>
          </div>
        ) : null}

        {scope === "custom" ? (
          <p className={scss.hintText}>
            Custom scope starts with no lines — add batches from the stocktake workspace after create.
          </p>
        ) : (
          <label className={css.checkboxRow} style={{ marginTop: "0.85rem" }}>
            <input
              type="checkbox"
              checked={seedLines}
              onChange={(e) => setSeedLines(e.target.checked)}
              disabled={saving}
            />
            <span>Auto-seed lines from scope (system qty from ledger)</span>
          </label>
        )}
      </section>

      <section className={css.createSection}>
        <h3 className={css.createSectionTitle}>Details</h3>
        <div className={css.createHeaderGrid}>
          <div className={css.field}>
            <label className={css.fieldLabel} htmlFor="stocktake-title">
              Name / reference
            </label>
            <input
              id="stocktake-title"
              className={css.input}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Near-expiry dispensary count"
              maxLength={160}
              disabled={saving}
            />
          </div>
          <div className={css.field}>
            <label className={css.fieldLabel} htmlFor="stocktake-area">
              Storage area
            </label>
            <input
              id="stocktake-area"
              className={css.input}
              value={areaLabel}
              onChange={(e) => setAreaLabel(e.target.value)}
              placeholder="Dispensary, main store, refrigerator…"
              maxLength={160}
              disabled={saving}
            />
          </div>
          <div className={css.field}>
            <label className={css.fieldLabel} htmlFor="stocktake-scheduled">
              Scheduled date and time
            </label>
            <input
              id="stocktake-scheduled"
              className={css.input}
              type="datetime-local"
              value={scheduledFor}
              onChange={(e) => setScheduledFor(e.target.value)}
              disabled={saving}
            />
            <p className={css.fieldHint}>Leave blank to create as a draft.</p>
          </div>
          <div className={css.field}>
            <label className={css.fieldLabel} htmlFor="stocktake-expected">
              Expected completion
            </label>
            <input
              id="stocktake-expected"
              className={css.input}
              type="datetime-local"
              value={expectedCompletionAt}
              onChange={(e) => setExpectedCompletionAt(e.target.value)}
              disabled={saving}
            />
          </div>
        </div>

        <div className={css.field} style={{ marginTop: "0.85rem" }}>
          <PurchasingSelect
            label="Movement handling"
            value={movementMode}
            options={MOVEMENT_MODE_OPTIONS}
            onChange={(value) => setMovementMode(value as StocktakeMovementMode)}
            disabled={saving}
          />
          <p className={css.fieldHint}>
            Freeze blocks stock movements for this branch while counting; continue reconciles
            movements that happen during the count.
          </p>
        </div>

        <div className={css.field} style={{ marginTop: "0.85rem" }}>
          <label className={css.fieldLabel} htmlFor="stocktake-notes">
            Notes (optional)
          </label>
          <textarea
            id="stocktake-notes"
            className={css.textarea}
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Shift count, cycle count area…"
            maxLength={2000}
            disabled={saving}
          />
        </div>
      </section>

      <section className={css.createSection}>
        <h3 className={css.createSectionTitle}>Counting options</h3>
        <label className={css.checkboxRow}>
          <input
            type="checkbox"
            checked={blindCount}
            onChange={(e) => setBlindCount(e.target.checked)}
            disabled={saving}
          />
          <span>Blind count — hide expected quantities and variance until supervisor review</span>
        </label>
      </section>
    </Modal>
  );
}
