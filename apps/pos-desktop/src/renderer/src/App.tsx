import { useCallback, useEffect, useState } from "react";
import type { ApiReachability, AppInfo, CheckStatus, Printer, ReadinessReport } from "../../shared/ipc-contract";
import styles from "./App.module.css";

const API_POLL_MS = 15_000;

const STATUS_LABEL: Record<CheckStatus, string> = {
  ok: "OK",
  warning: "Check",
  failed: "Failed",
  not_ready: "Not set up",
};

function PrinterTest() {
  const [printers, setPrinters] = useState<Printer[] | null>(null);
  const [selected, setSelected] = useState("");
  const [printing, setPrinting] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    window.pos
      .listPrinters()
      .then((list) => {
        setPrinters(list);
        setSelected(list[0]?.name ?? "");
      })
      .catch(() => setPrinters([]));
  }, []);

  async function print() {
    setPrinting(true);
    setMessage(null);
    try {
      const result = await window.pos.printTestReceipt({ printerName: selected });
      setMessage(
        result.ok
          ? { ok: true, text: "Sent to the printer. Check that the receipt came out." }
          : { ok: false, text: result.error ?? "The test receipt did not print." },
      );
    } catch {
      setMessage({ ok: false, text: "The test receipt did not print." });
    } finally {
      setPrinting(false);
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="printer-heading">
      <h2 id="printer-heading" className={styles.panelTitle}>
        Receipt printer test
      </h2>
      {printers === null ? (
        <p className="pc-muted">Looking for printers…</p>
      ) : printers.length === 0 ? (
        <p className="pc-muted">No printers are installed in Windows on this computer.</p>
      ) : (
        <>
          <label className={styles.field}>
            <span>Printer</span>
            <select value={selected} onChange={(event) => setSelected(event.target.value)} disabled={printing}>
              {printers.map((printer) => (
                <option key={printer.name} value={printer.name}>
                  {printer.displayName}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="pc-btn-primary-sm" onClick={print} disabled={printing || !selected}>
            {printing ? "Printing…" : "Print test receipt"}
          </button>
        </>
      )}
      {message && (
        <p role="status" className={message.ok ? styles.resultOk : styles.resultFailed}>
          {message.text}
        </p>
      )}
    </section>
  );
}

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [readiness, setReadiness] = useState<ReadinessReport | null>(null);
  const [api, setApi] = useState<ApiReachability | null>(null);

  const refreshApi = useCallback(() => {
    window.pos
      .checkApi()
      .then(setApi)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    window.pos
      .getAppInfo()
      .then(setInfo)
      .catch(() => undefined);
    window.pos
      .getReadiness()
      .then(setReadiness)
      .catch(() => undefined);
    refreshApi();
    const timer = window.setInterval(refreshApi, API_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refreshApi]);

  return (
    <div className={styles.shell}>
      <header className={styles.topBar}>
        <span className={styles.brand}>Curalio POS</span>
        <span className={`${styles.pill} ${styles.pillWarning}`}>Device not activated</span>
        <span className={styles.spacer} />
        <span
          className={`${styles.pill} ${api === null ? "" : api.reachable ? styles.pillOk : styles.pillDanger}`}
          role="status"
        >
          {api === null ? "Checking server…" : api.reachable ? "Server reachable" : "Server not reachable"}
        </span>
        {info && <span className={styles.version}>v{info.appVersion}</span>}
      </header>

      <main className={styles.content}>
        <section className={styles.panel} aria-labelledby="readiness-heading">
          <h2 id="readiness-heading" className={styles.panelTitle}>
            Offline readiness
          </h2>
          <p className={readiness?.ready ? styles.resultOk : styles.resultFailed}>
            {readiness === null
              ? "Checking…"
              : readiness.ready
                ? "This terminal is ready to sell during an outage."
                : "This terminal is not ready to sell during an outage."}
          </p>
          <ul className={styles.checks}>
            {readiness?.checks.map((check) => (
              <li key={check.id} className={styles.check}>
                <span className={`${styles.badge} ${styles[`badge_${check.status}`]}`}>
                  {STATUS_LABEL[check.status]}
                </span>
                <span className={styles.checkLabel}>{check.label}</span>
                <span className={styles.checkDetail}>{check.detail}</span>
              </li>
            ))}
          </ul>
        </section>

        <PrinterTest />
      </main>
    </div>
  );
}
