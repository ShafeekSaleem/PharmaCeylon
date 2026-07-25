"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { Modal, ModalButton, ModalFooter } from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import css from "../../purchasing/purchasing.module.css";
import {
  DEFAULT_NEAR_EXPIRY_DAYS,
  NEAR_EXPIRY_PRESETS,
  SCOPE_OPTIONS,
} from "../constants";
import type { StocktakeScope } from "../types";
import scss from "../stocktakes.module.css";

type Props = {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
};

export function CreateStocktakeModal({ open, onClose, onCreated }: Props) {
  const [notes, setNotes] = useState("");
  const [seedLines, setSeedLines] = useState(true);
  const [blindCount, setBlindCount] = useState(false);
  const [scope, setScope] = useState<StocktakeScope>("full");
  const [nearExpiryDays, setNearExpiryDays] = useState(DEFAULT_NEAR_EXPIRY_DAYS);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setNotes("");
    setSeedLines(true);
    setBlindCount(false);
    setScope("full");
    setNearExpiryDays(DEFAULT_NEAR_EXPIRY_DAYS);
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
        setError("Near-expiry days must be an integer between 1 and 730");
        return;
      }
    }

    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        notes: notes.trim() || null,
        seedLines: scope === "custom" ? false : seedLines,
        scope,
        blindCount,
      };
      if (scope === "near_expiry") {
        body.nearExpiryDays = Number(nearExpiryDays);
      }

      const created = await apiJson<{ id: string }>("/stocktakes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      onCreated(created.id);
      onClose();
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
      description="Choose a scope, then count batches and post variances."
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
      {error && <Alert variant="error">{error}</Alert>}

      <fieldset className={scss.scopeFieldset}>
        <legend className={css.fieldLabel}>Scope</legend>
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

      {scope === "near_expiry" && (
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
        </div>
      )}

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

      <label className={scss.seedToggle} style={{ marginTop: "0.85rem" }}>
        <input
          type="checkbox"
          checked={blindCount}
          onChange={(e) => setBlindCount(e.target.checked)}
          disabled={saving}
        />
        <span>
          Blind count — hide system quantities from counters until the stocktake is completed
        </span>
      </label>

      {scope !== "custom" && (
        <label className={scss.seedToggle} style={{ marginTop: "0.65rem" }}>
          <input
            type="checkbox"
            checked={seedLines}
            onChange={(e) => setSeedLines(e.target.checked)}
            disabled={saving}
          />
          <span>Auto-seed lines from scope (system qty from ledger)</span>
        </label>
      )}

      {scope === "custom" && (
        <p className={scss.hintText}>
          Custom scope starts with no lines — add batches from the stocktake detail after create.
        </p>
      )}
    </Modal>
  );
}
