"use client";

import { useMemo } from "react";
import { DatePicker } from "./date-picker";
import { SelectField, type SelectFieldOption } from "./select-field";
import css from "./date-time-field.module.css";

/**
 * A date and a time of day, for the few places that schedule something (a stocktake's start and
 * expected finish). It replaces `<input type="datetime-local">`, which opened the browser's own
 * picker — the one control left that ignored the theme after `DatePicker` landed.
 *
 * Reads and writes the same `YYYY-MM-DDTHH:mm` string the native input did, so call sites keep
 * their parsing. The day comes from the app's calendar and the time from the app's dropdown, in
 * half-hour steps; a value already holding an odd minute keeps it as an extra option.
 */

const DEFAULT_TIME = "09:00";

function halfHours(): string[] {
  const out: string[] = [];
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 30])
      out.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
  }
  return out;
}

function timeLabel(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h < 12 ? "AM" : "PM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

type Props = {
  /** `YYYY-MM-DDTHH:mm`, or `""` for none. */
  value: string;
  onChange: (value: string) => void;
  /** Accessible name for the pair; the time is read as "<label>, time". */
  label: string;
  id?: string;
  disabled?: boolean;
  /** `YYYY-MM-DD` bounds for the day. */
  min?: string;
  max?: string;
};

export function DateTimeField({
  value,
  onChange,
  label,
  id,
  disabled,
  min,
  max,
}: Props) {
  const date = value.slice(0, 10);
  const time = value.length >= 16 ? value.slice(11, 16) : "";

  const options = useMemo<SelectFieldOption[]>(() => {
    const steps = halfHours();
    if (time && !steps.includes(time)) steps.push(time);
    steps.sort();
    return steps.map((t) => ({ value: t, label: timeLabel(t) }));
  }, [time]);

  return (
    <div className={css.row}>
      <DatePicker
        id={id}
        label={label}
        variant="field"
        value={date}
        min={min}
        max={max}
        disabled={disabled}
        clearable
        placeholder="Select a date"
        onChange={(next) =>
          onChange(next ? `${next}T${time || DEFAULT_TIME}` : "")
        }
      />
      <SelectField
        label={`${label}, time`}
        hideLabel
        value={time}
        options={options}
        disabled={disabled || !date}
        onChange={(next) => onChange(date ? `${date}T${next}` : "")}
        className={css.time}
      />
    </div>
  );
}
