import { useRef, useState, type FormEvent } from "react";
import type { LocalShift, OfflineStaff } from "../../shared/ipc-contract";
import { DrawerTable } from "./CashShift";
import cash from "./CashShift.module.css";
import { counted, drawerCount, type DrawerEntry } from "./cash-count";
import { time } from "./format";
import { Icon } from "./Icon";
import { KeyHint } from "./KeyHint";
import { clickSubmit, useKeyBinding } from "./keymap";
import styles from "./OfflineCounter.module.css";
import { money } from "./sell-model";
import { PIN_OK } from "./SignIn";
import ui from "./ui.module.css";
import { cx, ErrorLine, useAction } from "./useAction";

/**
 * P4 #50: closing the till's shift while offline, as a journal entry. The person signed in closes
 * their own; a prepared manager closes someone else's with their own PIN and a reason. The count
 * is checked against what the drawer should hold; a difference is fine, and says so.
 */
export function OfflineClose({
  shift,
  me,
  canAssist,
  onClosed,
}: {
  shift: LocalShift;
  me: NonNullable<OfflineStaff["signedIn"]>;
  /** The signed-in person may close someone else's shift (a prepared manager). */
  canAssist: boolean;
  onClosed: () => void;
}) {
  const [entry, setEntry] = useState<DrawerEntry>({});
  const [note, setNote] = useState("");
  const [pin, setPin] = useState("");
  const [reason, setReason] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const { busy, error, run } = useAction();
  const assisted = shift.staffUserId !== me.staffUserId;
  const count = counted(entry) ? drawerCount(entry) : null;
  const variance = count ? count.totalMinor - shift.expectedCashMinor : 0;
  const ready =
    Boolean(count) &&
    !busy &&
    (!assisted || (PIN_OK.test(pin) && reason.trim().length > 0));
  useKeyBinding("Ctrl+Enter", () => clickSubmit(form.current), {
    enabled: ready,
  });

  if (assisted && !canAssist)
    return (
      <div className={styles.center}>
        <div className={cx(ui.panel, cash.count)} role="alert">
          <div className={cash.cntH}>
            <div className={ui.eyebrow}>Cash &amp; shift</div>
            <h2>{shift.staffName}&apos;s shift is open on this till</h2>
            <p>
              {shift.staffName.split(" ")[0]} closes it after signing in here,
              or a prepared manager closes it for them.
            </p>
          </div>
        </div>
      </div>
    );

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!count || !ready) return;
    const entered = pin;
    setPin("");
    void run(
      () =>
        window.pos.offlineCloseShift({
          count,
          ...(note.trim() ? { varianceNote: note.trim() } : {}),
          ...(assisted
            ? { assistance: { pin: entered, reason: reason.trim() } }
            : {}),
        }),
      onClosed,
    );
  }

  return (
    <div className={styles.center}>
      <form ref={form} className={cx(ui.panel, cash.count)} onSubmit={submit}>
        <div className={cash.cntH}>
          <div className={ui.eyebrow}>
            {assisted ? `Close ${shift.staffName}'s shift` : "Close your shift"}
          </div>
          <h2>Count the drawer</h2>
          <p>
            Opened {time(new Date(shift.openedAt))} with Rs{" "}
            {money(shift.openingCashMinor)}. The close is saved on this counter
            and uploads with the sales.
          </p>
        </div>
        <DrawerTable
          entry={entry}
          onChange={setEntry}
          disabled={busy}
          autoFocus
        />
        <div className={cash.tot3}>
          <div>
            <small>Counted</small>
            <b>{count ? money(count.totalMinor) : "—"}</b>
          </div>
          <div>
            <small>Expected</small>
            <b>{money(shift.expectedCashMinor)}</b>
          </div>
          <div className={cx(count && variance !== 0 && cash.short)}>
            <small>Difference</small>
            <b>
              {count
                ? `${variance < 0 ? "−" : variance > 0 ? "+" : ""}${money(Math.abs(variance))}`
                : "—"}
            </b>
          </div>
        </div>
        {count && variance !== 0 && (
          <div className={cx(ui.f, cash.field)}>
            <label htmlFor="offline-variance">What happened (optional)</label>
            <input
              id="offline-variance"
              className={ui.in}
              value={note}
              maxLength={500}
              disabled={busy}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        )}
        {assisted && (
          <>
            <div className={cx(ui.f, cash.field)}>
              <label htmlFor="offline-assist-reason">
                Why you&apos;re closing it for them
              </label>
              <input
                id="offline-assist-reason"
                className={ui.in}
                value={reason}
                maxLength={500}
                disabled={busy}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            <div className={cx(ui.f, cash.field)}>
              <label htmlFor="offline-assist-pin">
                Your PIN, {me.staffName.split(" ")[0]}
              </label>
              <input
                id="offline-assist-pin"
                className={ui.in}
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={8}
                value={pin}
                disabled={busy}
                onChange={(e) =>
                  setPin(e.target.value.replace(/\D/g, "").slice(0, 8))
                }
              />
            </div>
          </>
        )}
        <div className={cash.err}>
          <ErrorLine error={error} />
        </div>
        <div className={ui.dfoot}>
          <span className={ui.grow} />
          <button
            type="submit"
            className={cx(ui.btn, ui.primary, ui.lg)}
            disabled={!ready}
          >
            <Icon name="wallet" />
            {assisted ? "Close their shift" : "Close my shift"}
            <KeyHint keys="Ctrl+Enter" onPrimary small />
          </button>
        </div>
      </form>
    </div>
  );
}
