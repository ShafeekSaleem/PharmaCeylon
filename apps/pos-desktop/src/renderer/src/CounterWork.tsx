import { useCallback, useEffect, useState } from "react";
import type {
  RefundAtCounter,
  RefundExecuted,
} from "../../shared/ipc-contract";
import styles from "./App.module.css";

const amount = (minor: number) => (minor / 100).toFixed(2);

/** Remote-prepared work only the counter may execute. Hidden for people without the permission. */
export function CounterWork() {
  const [refunds, setRefunds] = useState<RefundAtCounter[] | null>(null);
  const [pending, setPending] = useState<
    { commandId: string; operation: string; createdAt: string }[]
  >([]);
  const [done, setDone] = useState<RefundExecuted | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void window.pos
      .refundsReady()
      .then((result) => setRefunds(result.ok ? result.value : []));
    void window.pos.pendingCommands().then(setPending);
  }, []);
  useEffect(load, [load]);

  async function execute(id: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await window.pos.executeRefund({ refundRequestId: id });
      if (result.ok) setDone(result.value);
      else setError(result.error.message);
    } finally {
      setBusy(false);
      load();
    }
  }

  async function confirm(commandId: string) {
    const result = await window.pos.retryCommand({ commandId });
    if (!result.ok) setError(result.error.message);
    load();
  }

  if (!refunds?.length && !pending.length && !done) return null;
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
