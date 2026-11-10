import Link from "next/link";
import type {
  CounterJournalSyncView,
  TerminalCounterView,
} from "@pharmaceylon/shared";
import { StatusBadge } from "@/components/ui";
import css from "../settings.module.css";

const dayKey = (at: number | Date, timeZone: string) =>
  new Date(at).toLocaleDateString("en-CA", { timeZone });

/**
 * "14:02" today, "3 Nov, 14:02" on another day, in the branch's timezone (as Daily work reads
 * it), so a manager looking from elsewhere sees the counter's own clock.
 */
export function syncTime(
  at: number,
  timeZone: string,
  now: Date = new Date(),
): string {
  const clock = { hour: "2-digit", minute: "2-digit", timeZone } as const;
  return dayKey(at, timeZone) === dayKey(now, timeZone)
    ? new Date(at).toLocaleTimeString("en-GB", clock)
    : new Date(at).toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        ...clock,
      });
}

/** One enrollment's journal on the server, in a manager's words. */
export function offlineSyncSummary(
  view: CounterJournalSyncView,
  timeZone: string,
  now: Date = new Date(),
): { text: string; tone: "ok" | "waiting" | "review" | "none" } {
  const stop = view.stoppedAt;
  if (stop)
    return {
      text: `Stopped at entry ${stop.sequence}`,
      tone: stop.outcome === "held" ? "waiting" : "review",
    };
  const last = view.lastReceivedAt ?? view.head?.acceptedAt ?? null;
  if (last === null) return { text: "No offline sales sent yet", tone: "none" };
  return {
    text: `All on the server, last received ${syncTime(last, timeZone, now)}`,
    tone: "ok",
  };
}

/** Why a current counter's journal stopped, and what moves it on. */
export function stoppedHint(
  view: CounterJournalSyncView,
  timeZone: string,
  now: Date = new Date(),
): string | null {
  const stop = view.stoppedAt;
  if (!stop) return null;
  const since = syncTime(stop.since, timeZone, now);
  switch (stop.outcome) {
    case "held":
      return `Held since ${since}: the counter hasn't sent something it needs yet, such as an earlier entry or a sign-in. It goes through on a later sync.`;
    case "rejected":
      return `Refused ${since}. Nothing after it syncs until it is reviewed.`;
    case "conflict":
      return `It doesn't match the server's copy. Nothing after it syncs until the counter's journal is recovered.`;
  }
}

const stockCases = (n: number) => (
  <Link href="/inventory/stock-cases">
    {n} {n === 1 ? "stock case" : "stock cases"} open
  </Link>
);

function earlierLabel(
  view: CounterJournalSyncView,
  timeZone: string,
  now: Date,
): string {
  if (view.retiredAt !== null) return `Retired computer ${view.terminalLabel}`;
  return view.revokedAt !== null
    ? `${view.terminalLabel}, key revoked ${syncTime(view.revokedAt, timeZone, now)}`
    : view.terminalLabel;
}

/**
 * The Counters page's "Offline sales" cell: how far the counter's current journal has reached
 * the server, then any earlier key or computer of this counter that stopped short.
 */
export function CounterOfflineSales({
  counter,
  journal,
  timeZone,
  failed,
  now = new Date(),
}: {
  counter: TerminalCounterView;
  journal: ReadonlyArray<CounterJournalSyncView> | null;
  timeZone: string;
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

  const summary = current ? offlineSyncSummary(current, timeZone, now) : null;
  const hint = current ? stoppedHint(current, timeZone, now) : null;
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
          {earlierLabel(view, timeZone, now)}:{" "}
          {view.stoppedAt
            ? `stopped at entry ${view.stoppedAt.sequence}`
            : "nothing waiting"}
          {view.openStockCases > 0 ? (
            <> · {stockCases(view.openStockCases)}</>
          ) : null}
        </div>
      ))}
    </div>
  );
}
