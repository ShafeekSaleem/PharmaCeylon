"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  IconCalendar,
  IconChevronLeft,
  IconChevronRight,
} from "@/components/icons";
import css from "./date-picker.module.css";

/**
 * The app's one calendar.
 *
 * Every date in the app used to be a native `<input type="date">`, so each browser drew its own
 * picker — the operating system's colours, its own fonts, light grey in dark mode — and the
 * filter bars looked themed right up until someone opened one. This is the replacement: one
 * popover, drawn with the `--pc-*` tokens, that reads and writes the same `YYYY-MM-DD` strings
 * the native input did, so swapping it in changes no call site's data.
 *
 * Two looks: `bare` sits inside a host that draws the box (the from/to halves of
 * `DateRangeField`), `field` is a standalone input matching the other form fields.
 */

type Variant = "bare" | "field";

type Props = {
  /** `YYYY-MM-DD`, or `""` for no date. */
  value: string;
  onChange: (value: string) => void;
  /** Earliest and latest selectable days, `YYYY-MM-DD`. */
  min?: string;
  max?: string;
  placeholder?: string;
  /** Accessible name — also read out for each day as "<label>, 21 September 2026". */
  label: string;
  variant?: Variant;
  /** Forwarded to the trigger so a `<label htmlFor>` points at it. */
  id?: string;
  disabled?: boolean;
  /** Offer a Clear button. Filters want one; a required form field does not. */
  clearable?: boolean;
  /** Keeps the browser's "please fill in this field" check that a native date input had. */
  required?: boolean;
  /** Marks the value as wrong — red border, `aria-invalid`. */
  invalid?: boolean;
  /** Id of the hint or error text that describes the field. */
  describedBy?: string;
  className?: string;
};

type Ymd = { y: number; m: number; d: number };

// ── Plain-date arithmetic. Everything is local calendar days, never instants, so a timezone
//    can never move a date by one. ──
const pad = (n: number) => String(n).padStart(2, "0");
const toIso = ({ y, m, d }: Ymd) => `${y}-${pad(m)}-${pad(d)}`;
function parseIso(value: string | undefined): Ymd | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}
const daysIn = (y: number, m: number) => new Date(y, m, 0).getDate();
const asDate = ({ y, m, d }: Ymd) => new Date(y, m - 1, d);
function addDays(day: Ymd, n: number): Ymd {
  const date = asDate(day);
  date.setDate(date.getDate() + n);
  return { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() };
}
function addMonths(day: Ymd, n: number): Ymd {
  const total = day.y * 12 + (day.m - 1) + n;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return { y, m, d: Math.min(day.d, daysIn(y, m)) };
}
function todayYmd(): Ymd {
  const now = new Date();
  return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
}
const same = (a: Ymd | null, b: Ymd | null) =>
  !!a && !!b && a.y === b.y && a.m === b.m && a.d === b.d;

/** How dates read everywhere else in the app's tables: "Sep 21, 2026". */
export function formatPickerDate(value: string): string {
  const day = parseIso(value);
  if (!day) return "";
  return asDate(day).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const POPOVER_WIDTH = 284;
const POPOVER_HEIGHT = 348;

export function DatePicker({
  value,
  onChange,
  min,
  max,
  placeholder = "Any date",
  label,
  variant = "bare",
  id,
  disabled = false,
  clearable = true,
  required = false,
  invalid = false,
  describedBy,
  className,
}: Props) {
  const selected = parseIso(value);
  const minDay = parseIso(min);
  const maxDay = parseIso(max);
  const [open, setOpen] = useState(false);
  const [focusDay, setFocusDay] = useState<Ymd>(() => selected ?? todayYmd());
  const [position, setPosition] = useState<CSSProperties>({});
  const [mounted, setMounted] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const gridId = useId();

  useEffect(() => setMounted(true), []);

  const outOfRange = useCallback(
    (day: Ymd) => {
      const t = asDate(day).getTime();
      return (
        (!!minDay && t < asDate(minDay).getTime()) ||
        (!!maxDay && t > asDate(maxDay).getTime())
      );
    },
    [minDay, maxDay],
  );

  const openPicker = () => {
    if (disabled) return;
    setFocusDay(selected ?? todayYmd());
    setOpen(true);
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };
  const choose = (day: Ymd) => {
    if (outOfRange(day)) return;
    onChange(toIso(day));
    close();
  };

  // Placed against the trigger, below it unless there's no room, and kept on screen.
  const place = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const below = window.innerHeight - rect.bottom;
    const up = below < POPOVER_HEIGHT + 12 && rect.top > below;
    const left = Math.min(
      Math.max(8, rect.left),
      window.innerWidth - POPOVER_WIDTH - 8,
    );
    setPosition(
      up
        ? { left, bottom: window.innerHeight - rect.top + 6 }
        : { left, top: rect.bottom + 6 },
    );
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        popoverRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      )
        return;
      close(false);
    };
    const onMove = () => place();
    // Escape closes the calendar, not the modal it opened in. Modals listen on `document`, so
    // this has to catch the key earlier — at `window`, in the capture phase — and stop it there.
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        event.preventDefault();
        close();
        return;
      }
      // Tab stays inside the calendar while it's open; a modal's own focus trap would otherwise
      // pull focus back into the form behind it and leave the calendar stranded open.
      if (
        event.key === "Tab" &&
        popoverRef.current?.contains(document.activeElement)
      ) {
        const focusable = [
          ...popoverRef.current.querySelectorAll<HTMLElement>(
            "button:not([disabled])",
          ),
        ].filter((el) => el.tabIndex !== -1);
        if (focusable.length === 0) return;
        event.stopPropagation();
        event.preventDefault();
        const at = focusable.indexOf(document.activeElement as HTMLElement);
        const next = event.shiftKey
          ? focusable[(at - 1 + focusable.length) % focusable.length]
          : focusable[(at + 1) % focusable.length];
        next?.focus();
      }
    };
    window.addEventListener("keydown", onEscape, true);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      window.removeEventListener("keydown", onEscape, true);
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, place]);

  // The focused day follows the keyboard; move real focus to it.
  useEffect(() => {
    if (!open) return;
    const button = popoverRef.current?.querySelector<HTMLButtonElement>(
      `[data-day="${toIso(focusDay)}"]`,
    );
    button?.focus({ preventScroll: true });
  }, [open, focusDay]);

  const weeks = useMemo(() => {
    const first: Ymd = { y: focusDay.y, m: focusDay.m, d: 1 };
    const lead = asDate(first).getDay();
    const start = addDays(first, -lead);
    return Array.from({ length: 6 }, (_, w) =>
      Array.from({ length: 7 }, (_, i) => addDays(start, w * 7 + i)),
    );
  }, [focusDay.y, focusDay.m]);

  const onGridKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, () => Ymd> = {
      ArrowLeft: () => addDays(focusDay, -1),
      ArrowRight: () => addDays(focusDay, 1),
      ArrowUp: () => addDays(focusDay, -7),
      ArrowDown: () => addDays(focusDay, 7),
      PageUp: () => addMonths(focusDay, event.shiftKey ? -12 : -1),
      PageDown: () => addMonths(focusDay, event.shiftKey ? 12 : 1),
      Home: () => addDays(focusDay, -asDate(focusDay).getDay()),
      End: () => addDays(focusDay, 6 - asDate(focusDay).getDay()),
    };
    if (moves[event.key]) {
      event.preventDefault();
      setFocusDay(moves[event.key]!());
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(focusDay);
    }
  };

  const today = todayYmd();
  const monthLabel = asDate(focusDay).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
  const shown = value ? formatPickerDate(value) : "";

  const popover = (
    <div
      ref={popoverRef}
      className={css.popover}
      style={{ ...position, width: POPOVER_WIDTH }}
      role="dialog"
      aria-modal="false"
      aria-label={`${label}: choose a date`}
    >
      <div className={css.header}>
        <button
          type="button"
          className={css.navButton}
          onClick={() => setFocusDay(addMonths(focusDay, -1))}
          aria-label="Previous month"
        >
          <IconChevronLeft size={16} />
        </button>
        <span className={css.monthLabel} aria-live="polite">
          {monthLabel}
        </span>
        <button
          type="button"
          className={css.navButton}
          onClick={() => setFocusDay(addMonths(focusDay, 1))}
          aria-label="Next month"
        >
          <IconChevronRight size={16} />
        </button>
      </div>

      <div className={css.weekdays} aria-hidden>
        {WEEKDAYS.map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>

      <div id={gridId} className={css.grid} role="grid" onKeyDown={onGridKey}>
        {weeks.map((week, w) => (
          <div key={w} className={css.week} role="row">
            {week.map((day) => {
              const iso = toIso(day);
              const isSelected = same(day, selected);
              const isFocus = same(day, focusDay);
              const disabledDay = outOfRange(day);
              return (
                <button
                  key={iso}
                  type="button"
                  role="gridcell"
                  data-day={iso}
                  tabIndex={isFocus ? 0 : -1}
                  disabled={disabledDay}
                  aria-selected={isSelected}
                  aria-label={asDate(day).toLocaleDateString("en-US", {
                    weekday: "long",
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                  })}
                  className={[
                    css.day,
                    day.m !== focusDay.m ? css.outside : "",
                    same(day, today) ? css.today : "",
                    isSelected ? css.selected : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={() => choose(day)}
                >
                  {day.d}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div className={css.footer}>
        <button
          type="button"
          className={css.footerButton}
          disabled={outOfRange(today)}
          onClick={() => choose(today)}
        >
          Today
        </button>
        {clearable && value ? (
          <button
            type="button"
            className={css.footerButton}
            onClick={() => {
              onChange("");
              close();
            }}
          >
            Clear
          </button>
        ) : null}
      </div>
    </div>
  );

  const trigger = (
    <button
      ref={triggerRef}
      id={id}
      type="button"
      className={[
        variant === "field" ? css.fieldTrigger : css.bareTrigger,
        invalid ? css.invalid : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-invalid={invalid || undefined}
      aria-required={required || undefined}
      aria-describedby={describedBy}
      onClick={() => (open ? close() : openPicker())}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" && !open) {
          event.preventDefault();
          openPicker();
        }
      }}
      disabled={disabled}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={shown ? `${label}: ${shown}` : `${label}: ${placeholder}`}
    >
      <span className={shown ? css.value : css.placeholder}>
        {shown || placeholder}
      </span>
      {variant === "field" ? (
        <IconCalendar size={15} className={css.fieldIcon} />
      ) : null}
    </button>
  );
  const portalled =
    open && mounted ? createPortal(popover, document.body) : null;

  if (!required) {
    return (
      <>
        {trigger}
        {portalled}
      </>
    );
  }
  // A button can't be `required`, so a hidden input carries the value for the form's own
  // validation, laid over the trigger so the browser's message points at the right field.
  return (
    <span className={css.requiredWrap}>
      {trigger}
      <input
        className={css.requiredProxy}
        tabIndex={-1}
        aria-hidden
        required
        value={value}
        onChange={() => {}}
        onFocus={() => triggerRef.current?.focus()}
      />
      {portalled}
    </span>
  );
}
