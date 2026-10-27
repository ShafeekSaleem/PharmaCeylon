import { IconAlertTriangle } from "@/components/icons";
import css from "./pos-fallback-banner.module.css";

/** "6:00 PM" today, "Wed, Oct 28, 6:00 PM" on another day — whichever reads as the end. */
export function formatFallbackEnd(endsAt: string, now: Date = new Date()): string {
  const end = new Date(endsAt);
  const sameDay = end.toDateString() === now.toDateString();
  return end.toLocaleString(
    undefined,
    sameDay
      ? { hour: "numeric", minute: "2-digit" }
      : { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
  );
}

/**
 * Shown on every page of a branch while its owner's web-POS fallback runs (D-W1), so nobody
 * mistakes fallback sales on the web for the counter being back.
 */
export function PosFallbackBanner({ endsAt }: { endsAt: string }) {
  return (
    <div className={css.banner} role="status">
      <span className={css.icon} aria-hidden>
        <IconAlertTriangle size={16} />
      </span>
      <p className={css.message}>
        Web POS fallback is on for this branch until{" "}
        <time dateTime={endsAt}>{formatFallbackEnd(endsAt)}</time>. Sales are recorded as fallback
        sales.
      </p>
    </div>
  );
}
