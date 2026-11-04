import { useCallback, useEffect, useState } from "react";
import type {
  RefundAtCounter,
  RefundExecuted,
} from "../../shared/ipc-contract";
import styles from "./App.module.css";
import { Icon } from "./Icon";
import { invoke } from "./invoke";
import { KeyHint } from "./KeyHint";
import { useKeyBinding } from "./keymap";
import shell from "./Shell.module.css";
import ui from "./ui.module.css";
import { cx } from "./useAction";

const amount = (minor: number) => (minor / 100).toFixed(2);
const POLL_MS = 30_000;

/** Remote-prepared work only the counter may execute. People without the permission see nothing waiting. */
export function CounterWork({
  onActivity,
  onCount,
  reloadKey = 0,
  poll = false,
}: {
  onActivity?: () => void;
  /** How many items are waiting, for the rail's badge. */
  onCount?: (count: number) => void;
  reloadKey?: number;
  /** Check again every so often, so a refund approved on the web turns up without a new sign-in. */
  poll?: boolean;
} = {}) {
  const [refunds, setRefunds] = useState<RefundAtCounter[] | null>(null);
  const [pending, setPending] = useState<
    {
      commandId: string;
      operation: string;
      createdAt: string;
      staffName: string | null;
    }[]
  >([]);
  const [done, setDone] = useState<RefundExecuted | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    (quiet = false) => {
      // A failed check keeps the list it had: a network blip shouldn't empty the page or the badge.
      void invoke(() => window.pos.refundsReady()).then((result) =>
        setRefunds((list) => (result.ok ? result.value : (list ?? []))),
      );
      void window.pos
        .pendingCommands()
        .then((list) => {
          setPending(list);
          if (!quiet) onActivity?.();
        })
        .catch(() => undefined);
    },
    [onActivity],
  );
  // Reloaded when a signed command is sent elsewhere (a prescription), so one left unconfirmed
  // shows here with its confirm button.
  useEffect(() => load(), [load, reloadKey]);
  useEffect(() => {
    if (!poll) return;
    const timer = window.setInterval(() => load(true), POLL_MS);
    return () => window.clearInterval(timer);
  }, [poll, load]);
  useEffect(() => {
    onCount?.((refunds?.length ?? 0) + pending.length);
  }, [refunds, pending, onCount]);

  async function execute(id: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await invoke(() =>
        window.pos.executeRefund({ refundRequestId: id }),
      );
      if (result.ok) setDone(result.value);
      else setError(result.error.message);
    } finally {
      setBusy(false);
      load();
    }
  }

  async function confirm(commandId: string) {
    setError(null);
    const result = await invoke(() => window.pos.retryCommand({ commandId }));
    if (!result.ok) setError(result.error.message);
    load();
  }

  // The page's main action only when there is exactly one thing to do: an action to confirm
  // (which comes first, so nothing is done twice), or else a refund to execute.
  const onlyPending = pending.length === 1 ? pending[0] : null;
  const onlyRefund =
    !pending.length && refunds?.length === 1 && !busy ? refunds[0] : null;
  useKeyBinding("Ctrl+Enter", () => void confirm(onlyPending!.commandId), {
    enabled: Boolean(onlyPending),
  });
  useKeyBinding(
    ["F12", "Ctrl+Enter"],
    () => void execute(onlyRefund!.refundRequestId),
    { enabled: Boolean(onlyRefund) },
  );

  if (!refunds?.length && !pending.length && !done)
    return refunds === null ? null : (
      <div className={cx(ui.panel, shell.empty)}>
        <Icon name="inbox" />
        Nothing is waiting at this counter.
      </div>
    );
  return (
    <section
      className={`${styles.panel} ${styles.wide}`}
      aria-label="Waiting at the counter"
    >
      <h2 className={styles.panelTitle}>Waiting at the counter</h2>
      {pending.length > 0 && (
        <div role="alert" className={styles.form}>
          <p className={styles.resultFailed}>
            An action was sent but not confirmed. Confirm it before doing it
            again.
          </p>
          {pending.map((p) => (
            <button
              key={p.commandId}
              type="button"
              className="pc-btn-outline"
              onClick={() => void confirm(p.commandId)}
            >
              Confirm action from {new Date(p.createdAt).toLocaleTimeString()}
              {p.staffName ? ` (sent by ${p.staffName})` : ""}
              {onlyPending && <KeyHint keys="Ctrl+Enter" spaced />}
            </button>
          ))}
        </div>
      )}
      {done && (
        <p role="status" className={styles.resultOk}>
          {done.alreadyApplied ? "Already refunded" : "Refunded"}{" "}
          {done.requestNumber}:{" "}
          {done.refundedTo
            .map((r) => `${amount(r.amountMinor)} ${r.method}`)
            .join(", ") || amount(done.amountMinor)}
          . Requested by {done.requestedBy ?? "—"}, approved by{" "}
          {done.approvedBy ?? "not needed"}, executed by you.
        </p>
      )}
      <ul className={styles.counterList}>
        {refunds?.map((r) => (
          <li key={r.refundRequestId} className={styles.counterOption}>
            <span>
              Refund {r.requestNumber} · {r.amount}
              {r.invoiceNo ? ` · sale ${r.invoiceNo}` : ""} · {r.reason}
              <br />
              <span className="pc-muted">
                Requested by {r.requestedBy ?? "—"} · approved by{" "}
                {r.approvedBy ?? "not needed"} · you execute
              </span>
            </span>
            <button
              type="button"
              className="pc-btn-primary-sm"
              onClick={() => void execute(r.refundRequestId)}
              disabled={busy}
            >
              Refund now
              {onlyRefund && <KeyHint keys="F12" onPrimary small spaced />}
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className={styles.resultFailed}>
          {error}
        </p>
      )}
    </section>
  );
}
