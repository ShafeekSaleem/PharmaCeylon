import Link from "next/link";
import type {
  CounterJournalSyncView,
  TerminalCounterView,
} from "@pharmaceylon/shared";
import { StatusBadge } from "@/components/ui";
import css from "../settings.module.css";

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/** "14:02" today, "3 Nov, 14:02" on another day, in the viewer's locale. */
export function syncTime(at: number, now: Date = new Date()): string {
  const when = new Date(at);
  const clock: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    minute: "2-digit",
  };
  return sameDay(when, now)
    ? when.toLocaleTimeString(undefined, clock)
    : when.toLocaleString(undefined, {
        day: "numeric",
        month: "short",
        ...clock,
      });
}

/** "3 waiting / 1 needs review", leaving out whichever is zero; null when nothing waits. */
export function waitingSummary(view: CounterJournalSyncView): string | null {
  const parts = [
    view.waiting > 0 ? `${view.waiting} waiting` : null,
    view.needsReview > 0
      ? `${view.needsReview} ${view.needsReview === 1 ? "needs" : "need"} review`
      : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" / ") : null;
}

/** One enrollment's journal on the server, in a manager's words. */
export function offlineSyncSummary(
  view: CounterJournalSyncView,
  now: Date = new Date(),
): { text: string; tone: "ok" | "waiting" | "review" | "none" } {
  const waiting = waitingSummary(view);
  if (waiting)
    return { text: waiting, tone: view.needsReview > 0 ? "review" : "waiting" };
  const last = view.lastUploadAt ?? view.head?.acceptedAt ?? null;
  if (last === null) return { text: "No offline sales sent yet", tone: "none" };
  return {
    text: `All on the server, last sync ${syncTime(last, now)}`,
    tone: "ok",
  };
}

function stuckHint(view: CounterJournalSyncView, now: Date): string | null {
  if (!view.stuck) return null;
  const why =
    view.stuck.outcome === "conflict"
      ? "doesn't match the server's copy"
      : `was refused ${syncTime(view.stuck.since, now)}`;
  return `Stopped at entry ${view.stuck.sequence}, which ${why}. Nothing after it can sync until it is reviewed.`;
}

const stockCases = (n: number) => (
  <Link href="/inventory/stock-cases">
    {n} {n === 1 ? "stock case" : "stock cases"} open
  </Link>
);

function earlierLabel(view: CounterJournalSyncView, now: Date): string {
  if (view.retiredAt !== null) return `Retired computer ${view.terminalLabel}`;
  return view.revokedAt !== null
    ? `${view.terminalLabel}, key revoked ${syncTime(view.revokedAt, now)}`
    : view.terminalLabel;
}

/**
 * The Counters page's "Offline sales" cell: how far the counter's current journal has reached
 * the server, then any earlier key or computer of this counter with entries still waiting.
 */
export function CounterOfflineSales({
  counter,
  journal,
  failed,
  now = new Date(),
}: {
  counter: TerminalCounterView;
  journal: CounterJournalSyncView[] | null;
  failed: boolean;
  now?: Date;
}) {
  if (failed) return <span className={css.rowHint}>Couldn&apos;t check</span>;
  if (journal === null) return <span className={css.rowHint}>Checking…</span>;
  const enrollmentId = counter.terminal?.enrollmentId ?? null;
  const current = enrollmentId
    ? journal.find((v) => v.enrollmentId === enrollmentId)
    : undefined;
  const earlier = journal.filter(
    (v) => !v.current && v.registerId === counter.registerId,
  );
  if (!current && earlier.length === 0)
    return <span className={css.rowHint}>—</span>;

  const summary = current ? offlineSyncSummary(current, now) : null;
  const hint = current ? stuckHint(current, now) : null;
  return (
    <div>
      {summary ? (
        summary.tone === "ok" || summary.tone === "none" ? (
          <span>{summary.text}</span>
        ) : (
          <StatusBadge
            status={summary.tone === "review" ? "needs_review" : "waiting"}
            label={summary.text}
            variant={summary.tone === "review" ? "danger" : "warning"}
          />
        )
      ) : null}
      {hint ? <div className={css.rowHint}>{hint}</div> : null}
      {current && current.openStockCases > 0 ? (
        <div className={css.rowHint}>{stockCases(current.openStockCases)}</div>
      ) : null}
      {earlier.map((view) => (
        <div key={view.enrollmentId} className={css.rowHint}>
          {earlierLabel(view, now)}: {waitingSummary(view) ?? "nothing waiting"}
          {view.openStockCases > 0 ? (
            <> · {stockCases(view.openStockCases)}</>
          ) : null}
        </div>
      ))}
    </div>
  );
}
