import { useEffect, useState } from "react";

/** Dates and times the way the mockups write them: "Sun 1 Nov", "14:32", "Sunday, 1 November 2026". */
function parts(date: Date, options: Intl.DateTimeFormatOptions) {
  const named: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of new Intl.DateTimeFormat("en-GB", options).formatToParts(
    date,
  ))
    named[part.type] = part.value;
  return named;
}

export function time(date: Date) {
  const p = parts(date, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return `${p.hour}:${p.minute}`;
}

export function timeWithSeconds(date: Date) {
  const p = parts(date, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  return `${p.hour}:${p.minute}:${p.second}`;
}

export function shortDay(date: Date) {
  const p = parts(date, { weekday: "short", day: "numeric", month: "short" });
  return `${p.weekday} ${p.day} ${p.month}`;
}

export function longDay(date: Date) {
  const p = parts(date, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  return `${p.weekday}, ${p.day} ${p.month} ${p.year}`;
}

export function dayMonthYear(date: Date) {
  const p = parts(date, { day: "numeric", month: "short", year: "numeric" });
  return `${p.day} ${p.month} ${p.year}`;
}

/** "Sachini Rathnayake" → "SR". */
export function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0] ?? "?";
  const last = words[words.length - 1] ?? "";
  return (
    words.length > 1 ? first.charAt(0) + last.charAt(0) : first.slice(0, 2)
  ).toUpperCase();
}

/** The current time, updated as each minute turns. */
export function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: number;
    const tick = () => {
      const next = new Date();
      setNow(next);
      timer = window.setTimeout(
        tick,
        60_000 - (next.getSeconds() * 1000 + next.getMilliseconds()) + 50,
      );
    };
    timer = window.setTimeout(
      tick,
      60_000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 50,
    );
    return () => window.clearTimeout(timer);
    // Started once; each tick schedules the next.
  }, []);
  return now;
}

/** "Sachini Rathnayake" → "Sachini R.", as the status bar names people. */
export function shortName(name: string) {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts.at(-1)![0]}.` : (parts[0] ?? name);
}

/** "14:32 today", "14:32 tomorrow", otherwise "Wed 6 Nov 14:32". */
export function relativeTime(date: Date, now = new Date()) {
  const day = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(date) - day(now)) / 86_400_000);
  if (days === 0) return `${time(date)} today`;
  if (days === 1) return `${time(date)} tomorrow`;
  if (days === -1) return `${time(date)} yesterday`;
  return `${shortDay(date)} ${time(date)}`;
}
