"use client";

import { useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/alert";
import { IconChevronDown, IconChevronRight, IconSearch } from "@/components/icons";
import { Modal, ModalButton, ModalFooter } from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";
import css from "../../purchasing/purchasing.module.css";
import { PurchasingSelect } from "../../purchasing/components/purchasing-select";
import {
  DEFAULT_NEAR_EXPIRY_DAYS,
  NEAR_EXPIRY_PRESETS,
  SCOPE_OPTIONS,
} from "../constants";
import type { StocktakeScope, StocktakeUserRef } from "../types";
import scss from "../stocktakes.module.css";

type Props = {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
};

type DirectoryUser = StocktakeUserRef & { email?: string };

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
  const [nearExpiryDays, setNearExpiryDays] = useState(DEFAULT_NEAR_EXPIRY_DAYS);
  const [scheduledFor, setScheduledFor] = useState("");
  const [expectedCompletionAt, setExpectedCompletionAt] = useState("");
  const [reviewerId, setReviewerId] = useState("");
  const [counterIds, setCounterIds] = useState<string[]>([]);
  const [counterQuery, setCounterQuery] = useState("");
  // Scheduling, movement handling and notes are edge cases — most stocktakes are "count now,
  // by me". Collapsed by default so the common path is a short form, not a long one to skim.
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [directory, setDirectory] = useState<DirectoryUser[]>([]);
  const [directoryHint, setDirectoryHint] = useState<string | null>(null);
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
    setNearExpiryDays(DEFAULT_NEAR_EXPIRY_DAYS);
    setScheduledFor("");
    setExpectedCompletionAt("");
    setReviewerId("");
    setCounterIds(user?.id ? [user.id] : []);
    setCounterQuery("");
    setShowAdvanced(false);
    setError(null);
    setSaving(false);
    setDirectoryHint(null);

    const fallback: DirectoryUser[] = [];
    if (user?.id) {
      fallback.push({ id: user.id, fullName: user.fullName || user.email || "You", email: user.email });
    }
    setDirectory(fallback);

    void apiJson<Array<{ id: string; fullName: string; email: string; isActive: boolean }>>(
      "/admin/users",
    )
      .then((rows) => {
        setDirectory(
          rows
            .filter((row) => row.isActive)
            .map((row) => ({ id: row.id, fullName: row.fullName, email: row.email })),
        );
        setDirectoryHint(null);
      })
      .catch(() => {
        setDirectoryHint(
          "Full user directory needs manager/owner access. You can still assign yourself as counter.",
        );
      });
  }, [open, user]);

  useEffect(() => {
    if (scope === "custom") setSeedLines(false);
  }, [scope]);

  const reviewerOptions = useMemo(
    () => [
      { value: "", label: "Unassigned" },
      ...directory.map((entry) => ({
        value: entry.id,
        label: entry.fullName,
        meta: entry.email,
      })),
    ],
    [directory],
  );

  const visibleCounters = useMemo(() => {
    const q = counterQuery.trim().toLowerCase();
    if (!q) return directory;
    return directory.filter((entry) =>
      `${entry.fullName} ${entry.email ?? ""}`.toLowerCase().includes(q),
    );
  }, [counterQuery, directory]);

  function toggleCounter(id: string) {
    setCounterIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  }

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
    if (counterIds.length === 0) {
      setError("Select at least one counter.");
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
        movementMode: "continue_and_reconcile",
        scheduledFor: scheduledIso,
        expectedCompletionAt: expectedIso,
        reviewerId: reviewerId || null,
        counterIds,
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
      description="Pick a scope, schedule, and assignees. You can count, review variances, and post from the workspace."
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
      {directoryHint ? (
        <div className={css.modalAlert}>
          <Alert variant="info">{directoryHint}</Alert>
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
        </div>

        <button
          type="button"
          className={scss.advancedToggle}
          onClick={() => setShowAdvanced((v) => !v)}
          aria-expanded={showAdvanced}
        >
          {showAdvanced ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
          Scheduling, movement handling &amp; notes
        </button>

        {showAdvanced && (
          <>
            <div className={css.createHeaderGrid} style={{ marginTop: "0.85rem" }}>
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
              <span className={css.fieldLabel}>Movement handling</span>
              {/* "Freeze stock transactions" used to be offered here, but nothing ever stopped a
                  sale or receipt during the count, so the option is gone until it is enforced. */}
              <p className={css.fieldHint}>
                Sales, receipts and transfers carry on while you count. Anything that moves after the
                count starts is reconciled automatically at review.
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
          </>
        )}
      </section>

      <section className={css.createSection}>
        <h3 className={css.createSectionTitle}>Assignment</h3>
        <PurchasingSelect
          label="Reviewer"
          value={reviewerId}
          options={reviewerOptions}
          onChange={setReviewerId}
          allowClear
          disabled={saving}
          placeholder="Unassigned"
        />
        <div className={css.field} style={{ marginTop: "0.85rem" }}>
          <span className={css.fieldLabel}>
            Counters
            {counterIds.length > 0 ? ` (${counterIds.length} selected)` : ""}
          </span>
          <div className={scss.pickerSearchWrap}>
            <IconSearch size={14} className={scss.pickerSearchIcon} />
            <input
              className={scss.pickerSearch}
              type="search"
              value={counterQuery}
              onChange={(e) => setCounterQuery(e.target.value)}
              placeholder="Search counters…"
              disabled={saving}
              aria-label="Search counters"
            />
          </div>
          <div className={scss.pickerList} role="group" aria-label="Assigned counters">
            {directory.length === 0 ? (
              <p className={scss.hintText} style={{ padding: "0.65rem" }}>
                No users available to assign.
              </p>
            ) : visibleCounters.length === 0 ? (
              <p className={scss.hintText} style={{ padding: "0.65rem" }}>
                No counters match “{counterQuery.trim()}”.
              </p>
            ) : (
              visibleCounters.map((entry) => {
                const checked = counterIds.includes(entry.id);
                return (
                  <label key={entry.id} className={scss.pickerRow}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleCounter(entry.id)}
                      disabled={saving}
                    />
                    <span className={scss.pickerRowBody}>
                      <span className={scss.pickerTitle}>{entry.fullName}</span>
                      {entry.email ? (
                        <span className={scss.pickerMeta}>{entry.email}</span>
                      ) : null}
                    </span>
                  </label>
                );
              })
            )}
          </div>
          <p className={css.fieldHint}>You are selected by default — add other counters as needed.</p>
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
