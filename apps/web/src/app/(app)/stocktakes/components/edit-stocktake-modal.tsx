"use client";

import { useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/alert";
import { IconSearch } from "@/components/icons";
import { Modal, ModalButton, ModalFooter } from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";
import { PurchasingSelect } from "../../purchasing/components/purchasing-select";
import css from "../../purchasing/purchasing.module.css";
import type { StocktakeListItem, StocktakeUserRef, UpdateStocktakePayload } from "../types";
import { datetimeLocalToIsoOrNull, isoToDatetimeLocal } from "../utils";
import scss from "../stocktakes.module.css";

type Props = {
  open: boolean;
  stocktake: StocktakeListItem;
  onClose: () => void;
  onSaved: (next: StocktakeListItem) => void;
};

type DirectoryUser = StocktakeUserRef & { email?: string };

export function EditStocktakeModal({ open, stocktake, onClose, onSaved }: Props) {
  const { user } = useAuth();
  const [title, setTitle] = useState("");
  const [areaLabel, setAreaLabel] = useState("");
  const [notes, setNotes] = useState("");
  const [scheduledFor, setScheduledFor] = useState("");
  const [expectedCompletionAt, setExpectedCompletionAt] = useState("");
  const [reviewerId, setReviewerId] = useState("");
  const [counterIds, setCounterIds] = useState<string[]>([]);
  const [counterQuery, setCounterQuery] = useState("");
  const [directory, setDirectory] = useState<DirectoryUser[]>([]);
  const [directoryHint, setDirectoryHint] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(stocktake.title ?? "");
    setAreaLabel(stocktake.areaLabel ?? "");
    setNotes(stocktake.notes ?? "");
    setScheduledFor(isoToDatetimeLocal(stocktake.scheduledFor));
    setExpectedCompletionAt(isoToDatetimeLocal(stocktake.expectedCompletionAt));
    setReviewerId(stocktake.reviewerId ?? stocktake.reviewer?.id ?? "");
    const assigned = stocktake.assignments.map((entry) => entry.user.id);
    setCounterIds(assigned.length > 0 ? assigned : [stocktake.countedBy || stocktake.counter.id]);
    setCounterQuery("");
    setError(null);
    setSaving(false);
    setDirectoryHint(null);

    const fallback: DirectoryUser[] = [];
    const pushUnique = (entry: StocktakeUserRef | null | undefined) => {
      if (!entry?.id) return;
      if (fallback.some((u) => u.id === entry.id)) return;
      fallback.push(entry);
    };
    pushUnique(stocktake.counter);
    pushUnique(stocktake.reviewer);
    for (const assignment of stocktake.assignments) pushUnique(assignment.user);
    if (user?.id) {
      pushUnique({ id: user.id, fullName: user.fullName || user.email || "You" });
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
          "Full user directory needs manager/owner access. Showing known users from this stocktake.",
        );
      });
  }, [open, stocktake, user]);

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
    const scheduledIso = datetimeLocalToIsoOrNull(scheduledFor);
    const expectedIso = datetimeLocalToIsoOrNull(expectedCompletionAt);
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
      const body: UpdateStocktakePayload = {
        title: title.trim() || null,
        areaLabel: areaLabel.trim() || null,
        notes: notes.trim() || null,
        scheduledFor: scheduledIso,
        expectedCompletionAt: expectedIso,
        reviewerId: reviewerId || null,
        counterIds,
      };
      const next = await apiJson<StocktakeListItem>(`/stocktakes/${stocktake.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      onSaved(next);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update stocktake");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit stocktake details"
      description="Update schedule, assignment, and instructions while the stocktake is still editable."
      size="lg"
      canDismiss={!saving}
      footer={
        <ModalFooter>
          <ModalButton variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </ModalButton>
          <ModalButton variant="primary" onClick={() => void submit()} loading={saving}>
            Save changes
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
        <h3 className={css.createSectionTitle}>Details</h3>
        <div className={css.createHeaderGrid}>
          <div className={css.field}>
            <label className={css.fieldLabel} htmlFor="edit-stocktake-title">
              Name / reference
            </label>
            <input
              id="edit-stocktake-title"
              className={css.input}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={160}
              disabled={saving}
            />
          </div>
          <div className={css.field}>
            <label className={css.fieldLabel} htmlFor="edit-stocktake-area">
              Storage area
            </label>
            <input
              id="edit-stocktake-area"
              className={css.input}
              value={areaLabel}
              onChange={(e) => setAreaLabel(e.target.value)}
              maxLength={160}
              disabled={saving}
            />
          </div>
          <div className={css.field}>
            <label className={css.fieldLabel} htmlFor="edit-stocktake-scheduled">
              Scheduled date and time
            </label>
            <input
              id="edit-stocktake-scheduled"
              className={css.input}
              type="datetime-local"
              value={scheduledFor}
              onChange={(e) => setScheduledFor(e.target.value)}
              disabled={saving}
            />
            <p className={css.fieldHint}>Required before using Schedule on a draft.</p>
          </div>
          <div className={css.field}>
            <label className={css.fieldLabel} htmlFor="edit-stocktake-expected">
              Expected completion
            </label>
            <input
              id="edit-stocktake-expected"
              className={css.input}
              type="datetime-local"
              value={expectedCompletionAt}
              onChange={(e) => setExpectedCompletionAt(e.target.value)}
              disabled={saving}
            />
          </div>
        </div>
        <div className={css.field} style={{ marginTop: "0.85rem" }}>
          <label className={css.fieldLabel} htmlFor="edit-stocktake-notes">
            Notes / instructions
          </label>
          <textarea
            id="edit-stocktake-notes"
            className={css.textarea}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            maxLength={2000}
            disabled={saving}
          />
        </div>
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
        </div>
      </section>
    </Modal>
  );
}
