import { useEffect, useRef, useState } from "react";
import type { CounterWorkReturnDetail, CounterWorkReturnLine } from "@pharmaceylon/shared";
import type { Printer } from "../../shared/ipc-contract";
import styles from "./CounterDocumentPane.module.css";
import { Icon } from "./Icon";
import { invoke } from "./invoke";
import { KeyHint } from "./KeyHint";
import { KeyScope, useKeyBinding } from "./keymap";
import { plural, qty } from "./stocktake-model";
import { handOverIssue, lineValue, returnQtyLabel, returnSummary, rs } from "./supplier-return-model";
import ui from "./ui.module.css";
import { cx } from "./useAction";

function ReturnLines({
  lines,
  showCost,
  ticked,
  onToggle,
  disabled,
}: {
  lines: ReadonlyArray<CounterWorkReturnLine>;
  showCost: boolean;
  ticked: (line: CounterWorkReturnLine) => boolean;
  onToggle: (line: CounterWorkReturnLine) => void;
  disabled: boolean;
}) {
  return (
    <table className={styles.lines}>
      <thead>
        <tr>
          <th aria-label="Packed" />
          <th>Product</th>
          <th>Batch</th>
          <th>Expiry</th>
          <th className={styles.num}>Quantity</th>
          <th>Where it is</th>
          {showCost && <th className={styles.num}>At cost</th>}
        </tr>
      </thead>
      <tbody>
        {lines.map((l) => (
          <tr key={l.itemId}>
            <td>
              <input
                type="checkbox"
                aria-label={`Packed: ${l.productName}`}
                checked={ticked(l)}
                disabled={disabled}
                onChange={() => onToggle(l)}
              />
            </td>
            <td>
              {l.productName}
              {l.packLabel && <small>{l.packLabel}</small>}
            </td>
            <td>{l.batchNo ?? "—"}</td>
            <td>{l.expiryDate ? l.expiryDate.slice(0, 7) : "—"}</td>
            <td className={styles.num}>{returnQtyLabel(l)}</td>
            <td>{l.quarantined ? "Quarantine" : "Shelf"}</td>
            {showCost && (
              <td className={styles.num}>
                {lineValue(l) ?? "—"}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** What completing does to money: the debit note, said the same way on the screen and the sheet. */
function debitNoteText(detail: CounterWorkReturnDetail) {
  const s = returnSummary(detail);
  const supplier = detail.subject ?? "the supplier";
  if (s.raisesDebitNote === false) return "The returned lines are worth nothing to claim, so no debit note is raised.";
  const value = s.amount !== null ? `for ${rs(s.amount)} ` : "";
  return `It raises a debit note ${value}against ${supplier}, applied to what this branch owes them, like a payment.`;
}

/** `sret-confirm`: the units that leave stock and the debit note. Ctrl+Enter completes, Esc goes back. */
function ConfirmSheet({
  detail,
  printed,
  busy,
  onComplete,
  onCancel,
}: {
  detail: CounterWorkReturnDetail;
  printed: boolean;
  busy: boolean;
  onComplete: () => void;
  onCancel: () => void;
}) {
  const s = returnSummary(detail);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => ref.current?.focus(), []);
  useKeyBinding("Ctrl+Enter", onComplete, { enabled: !busy });
  useKeyBinding("Escape", onCancel, { enabled: !busy });
  const where = [
    s.fromQuarantine ? `${qty(s.fromQuarantine)} from quarantine` : null,
    s.fromShelf ? `${qty(s.fromShelf)} from the shelf` : null,
  ]
    .filter(Boolean)
    .join(" and ");
  return (
    <section
      ref={ref}
      tabIndex={-1}
      className={styles.sheet}
      role="dialog"
      aria-modal="true"
      aria-labelledby="sret-confirm-title"
    >
      <div>
        <b id="sret-confirm-title">
          Hand over {detail.reference}
          {detail.subject ? ` to ${detail.subject}` : ""}?
        </b>
        <small className={styles.hint}>{plural(s.lines, "line")} packed</small>
      </div>
      <p>
        Takes <b>{plural(s.units, "unit")}</b> out of stock{where ? `: ${where}` : ""}. {debitNoteText(detail)}
      </p>
      <ul className={styles.checks}>
        <li>
          <Icon name="check" />
          Matches the version {detail.approved?.name ?? "the approver"} approved
        </li>
        <li>
          <Icon name={printed ? "check" : "info"} />
          {printed
            ? "Return note printed for the rep to sign"
            : "The return note hasn't been printed here. The rep's signed copy is the hand-over record."}
        </li>
      </ul>
      <p className={styles.hint}>Completing can't be undone. Anything still to sort out with the supplier goes through the web.</p>
      <div className={styles.actions}>
        <button type="button" className={cx(ui.btn, ui.outline)} disabled={busy} onClick={onCancel}>
          Cancel
          <KeyHint keys="Escape" small />
        </button>
        <button type="button" className={cx(ui.btn, ui.primary)} disabled={busy} onClick={onComplete}>
          {busy ? "Completing…" : "Hand over and complete"}
          <KeyHint keys="Ctrl+Enter" onPrimary small />
        </button>
      </div>
    </section>
  );
}

/**
 * `sret` Hand over supplier return. Approved on the web; the counter packs each line, prints the
 * return note for the rep and completes it. Completing takes the units out of stock and raises the
 * debit note in the same transaction. The counter never edits the return, and there is no waiver.
 */
export function SupplierReturnBody({
  detail,
  online,
  canPost,
  printer,
  ticked,
  onToggle,
  onCompleted,
  onRefused,
}: {
  detail: CounterWorkReturnDetail;
  online: boolean;
  /** Nothing else at this counter is waiting to be confirmed. */
  canPost: boolean;
  /** This counter's receipt printer; undefined while the list loads, null when there is none. */
  printer: Printer | null | undefined;
  ticked: (line: CounterWorkReturnLine) => boolean;
  onToggle: (line: CounterWorkReturnLine) => void;
  /** The ticks for this return can be forgotten, and the list read again. */
  onCompleted: () => void;
  /** Read the return again: the approval or the return moved on. */
  onRefused: () => void;
}) {
  const s = returnSummary(detail);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const [printed, setPrinted] = useState(false);
  const [printMessage, setPrintMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const packed = detail.lines.filter(ticked).length;
  const issue = handOverIssue({
    lines: s.lines,
    packed,
    online,
    canPost,
    approvalState: detail.approval.state,
  });
  const ready = issue === null && detail.approval.evidenceId !== null && !done;
  const showCost = detail.lines.some((l) => l.unitPrice !== null);

  // The sheet says the return matches what was approved and every line is packed; once that stops
  // being true it closes rather than leaving a button that does nothing.
  useEffect(() => {
    if (!ready) setConfirming(false);
  }, [ready]);

  useKeyBinding("Ctrl+Enter", () => setConfirming(true), { enabled: ready && !confirming });

  const print = async () => {
    if (!printer || printing) return;
    setPrinting(true);
    setPrintMessage(null);
    const result = await invoke(() =>
      window.pos.printCounterReturnNote({ id: detail.id, printerName: printer.name }),
    );
    setPrinting(false);
    if (result.ok && result.value.ok) {
      setPrinted(true);
      setPrintMessage({ ok: true, text: "Two copies sent to the printer. The rep signs one; keep the other with the branch file." });
    } else
      setPrintMessage({
        ok: false,
        text: result.ok ? (result.value.error ?? "The printer did not accept the job.") : result.error.message,
      });
  };

  const complete = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    const result = await invoke(() => window.pos.completeCounterReturn({ id: detail.id }));
    setBusy(false);
    setConfirming(false);
    if (!result.ok) {
      setError(result.error.message);
      onRefused();
      return;
    }
    const v = result.value;
    setDone(
      v.alreadyApplied
        ? `Already handed over. ${v.reference} was completed before.`
        : `Handed over. ${v.reference} has left stock${
            v.debitNoteRaised ? `; a debit note was raised against ${detail.subject ?? "the supplier"}.` : "; there was nothing to claim, so no debit note."
          }`,
    );
    onCompleted();
  };

  return (
    <>
      <div className={styles.facts}>
        <span>
          <Icon name="package" />
          {plural(s.lines, "line")} · {plural(s.units, "unit")}
        </span>
        {s.amount !== null && <span>{rs(s.amount)} at cost</span>}
        {s.reason && <span>Why: {s.reason}</span>}
      </div>
      <ReturnLines
        lines={detail.lines}
        showCost={showCost}
        ticked={ticked}
        onToggle={onToggle}
        disabled={busy || done !== null}
      />
      <div className={cx(ui.note, styles.waiting)} role="note">
        <Icon name="truck" />
        <div>
          <b>
            Handing over takes {plural(s.units, "unit")} out of stock
          </b>
          {debitNoteText(detail)}
          {s.lines > 0 && packed < s.lines && ` Tick every line as you pack it (${packed} of ${s.lines}).`}
        </div>
      </div>

      {!done && (
        <div className={styles.actions}>
          <small className={styles.hint}>
            Return note: print two copies. The rep signs one and you keep it with the branch file.
          </small>
          <button
            type="button"
            className={cx(ui.btn, ui.outline)}
            disabled={!printer || printing}
            title={printer ? `Prints on ${printer.displayName}` : "No receipt printer is set up on this counter"}
            onClick={() => void print()}
          >
            <Icon name="printer" />
            {printing ? "Printing…" : printed ? "Print again" : "Print return note"}
          </button>
        </div>
      )}
      {printMessage && (
        <p className={printMessage.ok ? ui.okText : ui.badText} role={printMessage.ok ? "status" : "alert"}>
          {printMessage.text}
        </p>
      )}

      {done && (
        <p className={ui.okText} role="status">
          {done}
        </p>
      )}
      {error && (
        <p role="alert" className={ui.badText}>
          {error}
        </p>
      )}

      {confirming && !done && (
        <KeyScope layer>
          <ConfirmSheet
            detail={detail}
            printed={printed}
            busy={busy}
            onComplete={() => void complete()}
            onCancel={() => setConfirming(false)}
          />
        </KeyScope>
      )}

      {!done && !confirming && (
        <div className={styles.actions}>
          <small className={styles.hint}>
            {issue ?? `${qty(packed)} of ${plural(s.lines, "line")} packed. You check the totals before it completes.`}
          </small>
          <button
            type="button"
            className={cx(ui.btn, ui.primary)}
            disabled={!ready}
            onClick={() => setConfirming(true)}
          >
            <Icon name="truck" />
            Hand over and complete
            <KeyHint keys="Ctrl+Enter" onPrimary small />
          </button>
        </div>
      )}
    </>
  );
}
