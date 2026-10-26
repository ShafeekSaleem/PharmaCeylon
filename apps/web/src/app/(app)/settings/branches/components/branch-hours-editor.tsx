"use client";

import { useMemo, useState } from "react";
import {
  BRANCH_HOURS_ERROR_CODES,
  WEEKDAYS,
  WEEKDAY_LABELS,
  daysWithoutMandatoryTime,
  isNoSelling,
  validateBranchHours,
  type BranchHoursView,
  type DayHours,
  type HolidaySuggestionsView,
  type HoursException,
  type Weekday,
} from "@pharmaceylon/shared";
import { Alert } from "@/components/alert";
import { IconCalendar, IconLock } from "@/components/icons";
import { ActionButton, Modal, ModalButton, ModalFooter, StatusBadge } from "@/components/ui";
import { ApiError } from "@/lib/api-error";
import settingsCss from "../../settings.module.css";
import { saveBranchHours } from "../hours-api";
import {
  branchToday,
  draftFromHours,
  formatDate,
  hoursFromDraft,
  startingHours,
  unrestrictedMandatoryDays,
  type HoursDraft,
  type MandatoryMode,
} from "../lib/hours-draft";
import css from "./branch-hours.module.css";
import { DayHoursField, MANDATORY_MODE_LABELS } from "./day-hours-field";

export const SYNC_NOTE = "Applies to counters after their next sync.";

type Props = {
  view: BranchHoursView;
  /** Owner, or the manager of this branch (the API enforces the same rule). */
  canEdit: boolean;
  /** Mandatory limits are the owner's alone. */
  canEditMandatory: boolean;
  holidays: HolidaySuggestionsView | null;
  onSaved: (view: BranchHoursView) => void;
};

/**
 * Routine hours, dated exceptions (with suggested holidays) and mandatory limits, saved together
 * as one document. Mandatory limits default to none, and "no selling" is only saved after a
 * second confirmation — a branch set that way can't sell even during an outage (D-W6).
 */
export function BranchHoursEditor({ view, canEdit, canEditMandatory, holidays, onSaved }: Props) {
  const [draft, setDraft] = useState<HoursDraft>(() => draftFromHours(view.hours ?? startingHours()));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmingNoSelling, setConfirmingNoSelling] = useState(false);

  // Start again from the server's copy only when the saved hours change. Approving or revoking
  // an extension also returns a new view (with a new version), and must not wipe unsaved edits.
  const savedKey = `${view.origin}:${JSON.stringify(view.hours)}`;
  const [loadedKey, setLoadedKey] = useState(savedKey);
  if (loadedKey !== savedKey) {
    setLoadedKey(savedKey);
    setDraft(draftFromHours(view.hours ?? startingHours()));
    setDirty(false);
  }

  function update(change: (d: HoursDraft) => HoursDraft) {
    setDraft((d) => change(d));
    setDirty(true);
    setSaved(false);
  }

  const today = branchToday(view.timezone);
  const mandatoryEditable = canEdit && canEditMandatory;

  /** A manager's save carries the stored mandatory limits back untouched. */
  function documentToSave() {
    const doc = hoursFromDraft(draft);
    return mandatoryEditable ? doc : { ...doc, mandatory: view.hours?.mandatory ?? null };
  }
  const pendingDoc = documentToSave();
  const noSellingDays = daysWithoutMandatoryTime(pendingDoc.mandatory);

  async function save(confirmNoSelling = false) {
    setErrors([]);
    setConflict(false);
    setSaved(false);
    const checked = validateBranchHours(documentToSave());
    if (!checked.ok) {
      setErrors([...checked.errors]);
      return;
    }
    if (isNoSelling(checked.value) && !isNoSelling(view.hours) && !confirmNoSelling) {
      setConfirmingNoSelling(true);
      return;
    }
    setSaving(true);
    try {
      const next = await saveBranchHours(view.branchId, {
        expectedVersion: view.version,
        hours: checked.value,
        ...(confirmNoSelling ? { confirmNoSelling: true } : {}),
      });
      setConfirmingNoSelling(false);
      onSaved(next);
      setSaved(true);
    } catch (e) {
      if (e instanceof ApiError && e.code === BRANCH_HOURS_ERROR_CODES.noSellingConfirmationRequired) {
        setConfirmingNoSelling(true);
      } else {
        setConfirmingNoSelling(false);
        if (e instanceof ApiError && e.code === BRANCH_HOURS_ERROR_CODES.versionConflict) setConflict(true);
        setErrors([e instanceof Error ? e.message : "Couldn't save the hours."]);
      }
    } finally {
      setSaving(false);
    }
  }

  const banner = view.hours
    ? view.origin === "legacy_text"
      ? {
          variant: "warning" as const,
          text: `These hours were read from what was entered before: “${view.legacyText}”. Check every day, then save.`,
        }
      : null
    : view.legacyText
      ? {
          variant: "info" as const,
          text: `The hours entered before couldn't be read automatically: “${view.legacyText}”. Enter them below, then save.`,
        }
      : {
          variant: "info" as const,
          text: "This branch has no hours yet. These are starting hours, not saved: change them to match the branch, then save.",
        };

  return (
    <div className={css.stack}>
      {banner ? <Alert variant={banner.variant}>{banner.text}</Alert> : null}

      <section className={settingsCss.card} aria-labelledby="routine-hours">
        <div className={settingsCss.cardHead}>
          <div>
            <h2 className={settingsCss.cardTitle} id="routine-hours">Routine hours</h2>
            <p className={settingsCss.cardDesc}>
              When the branch normally sells, in {view.timezone} time. Outside these hours, a manager at the counter
              can let selling continue during an outage, with a reason. A closing time earlier than the opening
              time runs past midnight.
            </p>
          </div>
        </div>
        {WEEKDAYS.map((day) => (
          <div className={css.dayRow} key={day}>
            <div className={css.dayLabel}>
              {WEEKDAY_LABELS[day]}
              {day === "mon" && canEdit ? (
                <div>
                  <button
                    type="button"
                    className={css.linkBtn}
                    onClick={() =>
                      update((d) => ({
                        ...d,
                        weekly: Object.fromEntries(WEEKDAYS.map((w) => [w, d.weekly.mon])) as HoursDraft["weekly"],
                      }))
                    }
                  >
                    Copy to every day
                  </button>
                </div>
              ) : null}
            </div>
            <DayHoursField
              label={WEEKDAY_LABELS[day]}
              value={draft.weekly[day]}
              disabled={!canEdit}
              onChange={(value) => update((d) => ({ ...d, weekly: { ...d.weekly, [day]: value } }))}
            />
          </div>
        ))}
      </section>

      <ExceptionsCard
        draft={draft}
        today={today}
        canEdit={canEdit}
        holidays={holidays}
        onChange={(exceptions) => update((d) => ({ ...d, exceptions }))}
      />

      <section className={settingsCss.card} aria-labelledby="mandatory-limits">
        <div className={settingsCss.cardHead}>
          <div>
            <h2 className={settingsCss.cardTitle} id="mandatory-limits">
              {!mandatoryEditable ? <IconLock size={14} /> : null} Mandatory selling limits
            </h2>
            <p className={settingsCss.cardDesc}>
              Hard limits nobody can go past at the counter, not even a manager during an outage. Set them only for
              limits this branch is required to follow. PharmaCeylon doesn&apos;t decide which hours the law permits.
            </p>
          </div>
        </div>
        {!canEditMandatory ? (
          <p className={settingsCss.rowHint}>Only the owner can change mandatory selling limits.</p>
        ) : null}
        <div className={css.choices} role="radiogroup" aria-label="Mandatory selling limits">
          {(
            [
              ["none", "No mandatory limit", "Counters follow the routine hours above. This is the default."],
              ["limited", "Only allow selling at set times", "Choose, day by day, when selling is allowed at all."],
              ["no_selling", "No selling at all", "Counters can't sell at this branch, at any time, until this is changed."],
            ] as [MandatoryMode, string, string][]
          ).map(([mode, title, hint]) => (
            <label
              key={mode}
              className={`${css.choice} ${draft.mandatoryMode === mode ? css.choiceOn : ""} ${mode === "no_selling" ? css.choiceDanger : ""}`}
            >
              <input
                type="radio"
                name="mandatory-mode"
                value={mode}
                checked={draft.mandatoryMode === mode}
                disabled={!mandatoryEditable}
                onChange={() =>
                  update((d) => ({
                    ...d,
                    mandatoryMode: mode,
                    mandatoryDays: mode === "limited" && d.mandatoryMode !== "limited" ? unrestrictedMandatoryDays() : d.mandatoryDays,
                  }))
                }
              />
              <span>
                <span className={css.choiceTitle}>{title}</span>
                <span className={css.choiceHint} style={{ display: "block" }}>{hint}</span>
              </span>
            </label>
          ))}
        </div>
        {draft.mandatoryMode === "limited" ? (
          <div style={{ marginTop: "0.75rem" }}>
            {WEEKDAYS.map((day) => (
              <div className={css.dayRow} key={day}>
                <div className={css.dayLabel}>{WEEKDAY_LABELS[day]}</div>
                <DayHoursField
                  label={`Mandatory ${WEEKDAY_LABELS[day]}`}
                  labels={MANDATORY_MODE_LABELS}
                  value={draft.mandatoryDays[day]}
                  disabled={!mandatoryEditable}
                  onChange={(value) =>
                    update((d) => ({ ...d, mandatoryDays: { ...d.mandatoryDays, [day]: value } }))
                  }
                />
              </div>
            ))}
          </div>
        ) : null}
        {isNoSelling(pendingDoc) ? (
          <p className={css.warnText}>No selling at all at this branch, at any time. Counters stop selling after their next sync.</p>
        ) : noSellingDays.length > 0 ? (
          <p className={css.warnText}>
            No selling at all on {noSellingDays.map((d: Weekday) => WEEKDAY_LABELS[d]).join(", ")}.
          </p>
        ) : null}
      </section>

      {canEdit ? (
        <div className={css.saveBar}>
          <span className={css.syncNote}>{SYNC_NOTE}</span>
          {saved ? <span className={settingsCss.saveOk}>Hours saved.</span> : null}
          <ActionButton onClick={() => void save()} disabled={saving || (!dirty && view.origin === "editor")}>
            {saving ? "Saving…" : "Save hours"}
          </ActionButton>
        </div>
      ) : (
        <p className={css.syncNote}>{SYNC_NOTE}</p>
      )}
      {errors.length > 0 ? (
        <Alert variant="error">
          {errors.length === 1 ? (
            errors[0]
          ) : (
            <ul className={css.errorList}>
              {errors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
          {conflict ? (
            <div>
              <button type="button" className={css.linkBtn} onClick={() => window.location.reload()}>
                Reload
              </button>
            </div>
          ) : null}
        </Alert>
      ) : null}

      <Modal
        open={confirmingNoSelling}
        onClose={() => setConfirmingNoSelling(false)}
        title={`Stop all selling at ${view.branchName}?`}
        size="sm"
        canDismiss={!saving}
        footer={
          <ModalFooter>
            <ModalButton variant="secondary" onClick={() => setConfirmingNoSelling(false)} disabled={saving}>
              Keep selling
            </ModalButton>
            <ModalButton variant="danger" onClick={() => void save(true)} loading={saving}>
              Stop all selling
            </ModalButton>
          </ModalFooter>
        }
      >
        <p className={settingsCss.rowHint} style={{ fontSize: "0.85rem" }}>
          Counters at {view.branchName} won&apos;t be able to sell at all: not in routine hours, not with a
          manager&apos;s acknowledgement, and not during an outage, until an owner changes this. {SYNC_NOTE}
        </p>
      </Modal>
    </div>
  );
}

type ExceptionsProps = {
  draft: HoursDraft;
  today: string;
  canEdit: boolean;
  holidays: HolidaySuggestionsView | null;
  onChange: (exceptions: HoursException[]) => void;
};

function ExceptionsCard({ draft, today, canEdit, holidays, onChange }: ExceptionsProps) {
  const [date, setDate] = useState("");
  const [label, setLabel] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const exceptions = draft.exceptions;
  const sorted = useMemo(() => [...exceptions].sort((a, b) => a.date.localeCompare(b.date)), [exceptions]);
  const pastCount = sorted.filter((e) => e.date < today).length;

  const offered = (holidays?.holidays ?? []).filter(
    (h) => !exceptions.some((e) => e.date === h.date || (e.holidayKey !== null && e.holidayKey === h.key)),
  );

  function patch(target: HoursException, change: Partial<HoursException>) {
    onChange(exceptions.map((e) => (e === target ? { ...e, ...change } : e)));
  }

  function add() {
    if (!date) return setAddError("Choose a date.");
    if (!label.trim()) return setAddError("Give the date a name, such as “Stocktake”.");
    if (exceptions.some((e) => e.date === date)) return setAddError("That date already has an exception.");
    onChange([...exceptions, { date, label: label.trim(), hours: { mode: "closed" }, source: "owner", holidayKey: null }]);
    setDate("");
    setLabel("");
    setAddError(null);
  }

  function addPicked() {
    const chosen = offered.filter((h) => picked.has(h.key));
    onChange([
      ...exceptions,
      ...chosen.map((h) => ({
        date: h.date,
        label: h.name,
        hours: { mode: "closed" } as DayHours,
        source: "holiday_suggestion" as const,
        holidayKey: h.key,
      })),
    ]);
    setPicked(new Set());
  }

  return (
    <section className={settingsCss.card} aria-labelledby="dated-exceptions">
      <div className={settingsCss.cardHead}>
        <div>
          <h2 className={settingsCss.cardTitle} id="dated-exceptions">
            <IconCalendar size={16} /> Dates with different hours
          </h2>
          <p className={settingsCss.cardDesc}>
            Holidays, stocktake days and other dates when the routine hours don&apos;t apply. Hours that start the
            evening before and run past midnight still finish as planned.
          </p>
        </div>
      </div>

      {sorted.length === 0 ? <p className={css.muted}>No dates added.</p> : null}
      {sorted.map((exception) => {
        const past = exception.date < today;
        return (
          <div className={`${css.exceptionRow} ${past ? css.past : ""}`} key={exception.date}>
            <div className={css.dayLabel}>
              {formatDate(exception.date)}
              {exception.source === "holiday_suggestion" ? (
                <div className={css.dayMeta}>Suggested holiday</div>
              ) : null}
            </div>
            <input
              className={css.control}
              aria-label={`Name for ${exception.date}`}
              value={exception.label}
              disabled={!canEdit}
              onChange={(e) => patch(exception, { label: e.target.value })}
            />
            <DayHoursField
              label={`Hours on ${exception.date}`}
              value={exception.hours}
              disabled={!canEdit}
              onChange={(hours) => patch(exception, { hours })}
            />
            {canEdit ? (
              <button
                type="button"
                className={`${css.linkBtn} ${css.dangerLink}`}
                aria-label={`Remove ${exception.date}`}
                onClick={() => onChange(exceptions.filter((e) => e !== exception))}
              >
                Remove
              </button>
            ) : (
              <span />
            )}
          </div>
        );
      })}
      {canEdit && pastCount > 0 ? (
        <button
          type="button"
          className={css.linkBtn}
          onClick={() => onChange(exceptions.filter((e) => e.date >= today))}
        >
          Remove {pastCount} past {pastCount === 1 ? "date" : "dates"}
        </button>
      ) : null}

      {canEdit ? (
        <>
          <div className={css.addRow}>
            <label className={css.muted}>
              Date
              <input
                type="date"
                className={`${css.control} ${css.select}`}
                aria-label="New date"
                min={today}
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </label>
            <label className={css.muted}>
              Name
              <input
                className={`${css.control} ${css.select}`}
                aria-label="New date name"
                placeholder="Stocktake"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </label>
            <ActionButton variant="secondary" onClick={add}>
              Add date
            </ActionButton>
          </div>
          {addError ? <p className={settingsCss.saveError}>{addError}</p> : null}
        </>
      ) : null}

      <p className={settingsCss.subLabel} style={{ marginTop: "1.25rem" }}>
        Suggested public and poya holidays
      </p>
      {holidays === null ? (
        <p className={css.muted}>Holiday suggestions couldn&apos;t be loaded.</p>
      ) : holidays.source === null ? (
        <p className={css.muted}>
          No public or poya holiday list has been set up yet, so there&apos;s nothing to suggest. Add holidays as dates
          above.
        </p>
      ) : (
        <>
          <p className={css.muted}>
            From {holidays.source.name}. These are suggestions: check what each one means for this branch before adding
            it. PharmaCeylon suggests holidays but doesn&apos;t decide legal trading hours.
          </p>
          {offered.length === 0 ? <p className={css.muted}>Every upcoming holiday is already added.</p> : null}
          {offered.map((holiday) => (
            <label className={css.suggestion} key={holiday.key}>
              <input
                type="checkbox"
                checked={picked.has(holiday.key)}
                disabled={!canEdit}
                onChange={(e) =>
                  setPicked((current) => {
                    const next = new Set(current);
                    if (e.target.checked) next.add(holiday.key);
                    else next.delete(holiday.key);
                    return next;
                  })
                }
              />
              <span>
                {formatDate(holiday.date)} — {holiday.name}
              </span>
              {holiday.kinds.includes("poya") ? (
                <StatusBadge status="poya" variant="info" label="Poya" />
              ) : null}
            </label>
          ))}
          {canEdit && offered.length > 0 ? (
            <ActionButton variant="secondary" onClick={addPicked} disabled={picked.size === 0}>
              Add selected as closed days
            </ActionButton>
          ) : null}
        </>
      )}
    </section>
  );
}
