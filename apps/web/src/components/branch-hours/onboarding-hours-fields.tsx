"use client";
import {
  WEEKDAYS,
  WEEKDAY_LABELS,
  MAX_HOURS_EXCEPTIONS,
  type BranchHours,
} from "@pharmaceylon/shared";
import { DayHoursField } from "@/app/(app)/settings/branches/components/day-hours-field";
import { startingHours } from "@/app/(app)/settings/branches/lib/hours-draft";
import css from "@/app/(app)/settings/branches/components/branch-hours.module.css";

/** Controlled pre-tenant fields reuse W7's model/day controls; no server branch yet. */
export function OnboardingHoursFields({
  value,
  onChange,
}: {
  value: BranchHours | null | undefined;
  onChange: (hours: BranchHours | null) => void;
}) {
  return (
    <fieldset>
      <legend>Routine opening hours</legend>
      <label>
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) =>
            onChange(event.target.checked ? startingHours() : null)
          }
        />{" "}
        Set routine opening hours now
      </label>
      <p className={css.syncNote}>
        Times use the branch time zone. Leave these unset to configure them in
        Branch settings. Mandatory selling limits and business extensions are
        configured separately after setup; no hard restriction is inferred here.
      </p>
      {value ? (
        <>
          {WEEKDAYS.map((day) => (
            <div key={day} className={css.dayRow}>
              <strong className={css.dayLabel}>{WEEKDAY_LABELS[day]}</strong>
              <DayHoursField
                label={WEEKDAY_LABELS[day]}
                value={value.weekly[day]}
                onChange={(hours) =>
                  onChange({
                    ...value,
                    weekly: { ...value.weekly, [day]: hours },
                  })
                }
              />
            </div>
          ))}
          <h3>Dates with different hours</h3>
          {value.exceptions.map((exception, index) => (
            <div key={index} className={css.stack}>
              <label>
                Date{" "}
                <input
                  aria-label={`Exception date ${index + 1}`}
                  type="date"
                  value={exception.date}
                  onChange={(event) =>
                    onChange({
                      ...value,
                      exceptions: value.exceptions.map((row, i) =>
                        i === index
                          ? { ...row, date: event.target.value }
                          : row,
                      ),
                    })
                  }
                />
              </label>
              <label>
                Reason{" "}
                <input
                  aria-label={`Exception reason ${index + 1}`}
                  maxLength={80}
                  value={exception.label}
                  onChange={(event) =>
                    onChange({
                      ...value,
                      exceptions: value.exceptions.map((row, i) =>
                        i === index
                          ? { ...row, label: event.target.value }
                          : row,
                      ),
                    })
                  }
                />
              </label>
              <DayHoursField
                label={`Exception ${index + 1}`}
                value={exception.hours}
                onChange={(hours) =>
                  onChange({
                    ...value,
                    exceptions: value.exceptions.map((row, i) =>
                      i === index ? { ...row, hours } : row,
                    ),
                  })
                }
              />
              <button
                type="button"
                onClick={() =>
                  onChange({
                    ...value,
                    exceptions: value.exceptions.filter((_, i) => i !== index),
                  })
                }
              >
                Remove date {index + 1}
              </button>
            </div>
          ))}
          <button
            type="button"
            disabled={value.exceptions.length >= MAX_HOURS_EXCEPTIONS}
            onClick={() =>
              onChange({
                ...value,
                exceptions: [
                  ...value.exceptions,
                  {
                    date: "",
                    label: "",
                    hours: { mode: "closed" },
                    source: "owner",
                    holidayKey: null,
                  },
                ],
              })
            }
          >
            Add a date with different hours
          </button>
        </>
      ) : null}
    </fieldset>
  );
}
