"use client";

import { MAX_RANGES_PER_DAY, type DayHours, type HoursRange } from "@pharmaceylon/shared";
import { DEFAULT_RANGE, endsNextDay, timeInputValue } from "../lib/hours-draft";
import css from "./branch-hours.module.css";

export type DayModeLabels = Record<DayHours["mode"], string>;

export const ROUTINE_MODE_LABELS: DayModeLabels = {
  hours: "Open",
  open_24h: "Open 24 hours",
  closed: "Closed",
};

/** The same three choices, as a mandatory limit: open_24h adds no limit, closed stops selling. */
export const MANDATORY_MODE_LABELS: DayModeLabels = {
  hours: "Only between…",
  open_24h: "Any time",
  closed: "No selling",
};

type Props = {
  /** Names the controls for screen readers and tests, e.g. "Monday" or "Mandatory Monday". */
  label: string;
  value: DayHours;
  onChange: (value: DayHours) => void;
  disabled?: boolean;
  labels?: DayModeLabels;
};

/** One day's hours: closed, open 24 hours, or up to four ranges (a range may run past midnight). */
export function DayHoursField({ label, value, onChange, disabled, labels = ROUTINE_MODE_LABELS }: Props) {
  const ranges = value.mode === "hours" ? value.ranges : [];

  function setMode(mode: DayHours["mode"]) {
    if (mode === "hours") onChange({ mode, ranges: ranges.length ? ranges : [DEFAULT_RANGE] });
    else onChange({ mode });
  }

  function setRange(index: number, patch: Partial<HoursRange>) {
    onChange({ mode: "hours", ranges: ranges.map((r, i) => (i === index ? { ...r, ...patch } : r)) });
  }

  function addRange() {
    const last = ranges[ranges.length - 1];
    const next = last && last.closes < "22:00" ? { opens: last.closes, closes: "22:00" } : DEFAULT_RANGE;
    onChange({ mode: "hours", ranges: [...ranges, next] });
  }

  return (
    <>
      <select
        className={`${css.control} ${css.select}`}
        aria-label={label}
        value={value.mode}
        disabled={disabled}
        onChange={(e) => setMode(e.target.value as DayHours["mode"])}
      >
        <option value="hours">{labels.hours}</option>
        <option value="open_24h">{labels.open_24h}</option>
        <option value="closed">{labels.closed}</option>
      </select>
      <div className={css.ranges}>
        {ranges.map((range, index) => {
          const n = ranges.length > 1 ? ` ${index + 1}` : "";
          return (
            <div className={css.range} key={index}>
              <input
                type="time"
                className={css.control}
                aria-label={`${label} from${n}`}
                value={timeInputValue(range.opens)}
                disabled={disabled}
                onChange={(e) => setRange(index, { opens: e.target.value })}
              />
              <span className={css.muted}>to</span>
              <input
                type="time"
                className={css.control}
                aria-label={`${label} until${n}`}
                value={timeInputValue(range.closes)}
                disabled={disabled}
                onChange={(e) => setRange(index, { closes: e.target.value })}
              />
              {endsNextDay(range) ? <span className={css.nextDay}>ends the next day</span> : null}
              {ranges.length > 1 && !disabled ? (
                <button
                  type="button"
                  className={`${css.linkBtn} ${css.dangerLink}`}
                  aria-label={`Remove ${label} hours${n}`}
                  onClick={() => onChange({ mode: "hours", ranges: ranges.filter((_, i) => i !== index) })}
                >
                  Remove
                </button>
              ) : null}
            </div>
          );
        })}
        {value.mode === "hours" && ranges.length < MAX_RANGES_PER_DAY && !disabled ? (
          <div>
            <button type="button" className={css.linkBtn} onClick={addRange} aria-label={`Add hours to ${label}`}>
              + Add hours
            </button>
          </div>
        ) : null}
      </div>
    </>
  );
}
