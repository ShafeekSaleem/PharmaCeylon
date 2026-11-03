import { useEffect, useRef, useState } from "react";
import type {
  ApiReachability,
  DeviceState,
  Printer,
} from "../../shared/ipc-contract";
import { longDay, time, useNow } from "./format";
import { Icon } from "./Icon";
import full from "./Fullscreen.module.css";
import { SignInForm } from "./Setup";
import { atTheComputer, Avatar } from "./Shell";
import styles from "./SignIn.module.css";
import ui from "./ui.module.css";
import { cx, ErrorLine, useAction } from "./useAction";

type Props = { state: DeviceState; onState: (state: DeviceState) => void };

export const PIN_OK = /^\d{4,8}$/;
const PIN_MAX = 8;

/** Dots and a number pad. The keyboard's digits, Backspace and Enter work too. */
function PinPad({
  value,
  onChange,
  onSubmit,
  busy,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  busy: boolean;
}) {
  const ready = PIN_OK.test(value);
  const pad = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (busy || event.ctrlKey || event.altKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select")) return;
      if (/^\d$/.test(event.key)) {
        if (value.length < PIN_MAX) onChange(value + event.key);
      } else if (event.key === "Backspace") onChange(value.slice(0, -1));
      else if (event.key === "Enter") {
        // A focused button outside the pad ("Someone else") does its own thing with Enter.
        if (target?.closest("button, a") && !pad.current?.contains(target))
          return;
        if (ready) onSubmit();
      } else return;
      event.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, value, ready, onChange, onSubmit]);

  const dots = Math.max(4, value.length);
  return (
    <>
      <div
        className={styles.dots}
        role="status"
        aria-label={`${value.length} digits entered`}
      >
        {Array.from({ length: dots }, (_, i) => (
          <i key={i} className={i < value.length ? styles.filled : undefined} />
        ))}
      </div>
      <div className={styles.pad} ref={pad}>
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => (
          <button
            key={digit}
            type="button"
            onClick={() => value.length < PIN_MAX && onChange(value + digit)}
            disabled={busy}
          >
            {digit}
          </button>
        ))}
        <button
          type="button"
          aria-label="Delete a digit"
          onClick={() => onChange(value.slice(0, -1))}
          disabled={busy}
        >
          <Icon name="backspace" />
        </button>
        <button
          type="button"
          onClick={() => value.length < PIN_MAX && onChange(value + "0")}
          disabled={busy}
        >
          0
        </button>
        <button
          type="button"
          className={styles.go}
          aria-label="Unlock"
          onClick={onSubmit}
          disabled={busy || !ready}
        >
          <Icon name="arrow-right" />
        </button>
      </div>
    </>
  );
}

function Chips({
  state,
  api,
  printer,
}: {
  state: DeviceState;
  api: ApiReachability | null;
  printer: Printer | null | undefined;
}) {
  const local = atTheComputer(state);
  return (
    <div className={full.chips}>
      <span
        className={cx(
          ui.pill,
          api?.reachable ? ui.ok : api ? ui.bad : ui.neutral,
        )}
      >
        <Icon name="cloud" />
        {api === null
          ? "Checking the server…"
          : api.reachable
            ? "Server reachable"
            : "Server not reachable"}
      </span>
      {printer !== undefined && (
        <span className={cx(ui.pill, printer ? ui.neutral : ui.warn)}>
          <Icon name="printer" />
          {printer ? printer.displayName : "No printer installed"}
        </span>
      )}
      <span className={cx(ui.pill, local ? ui.ok : ui.bad)}>
        <Icon name="monitor" />
        {local ? "At the counter · console session" : "Remote session"}
      </span>
    </div>
  );
}

/**
 * Full screen while nobody is signed in, and the lock screen while someone is. Unlocking takes the
 * signed-in person's own PIN; anyone else signs in with their email and password, which signs the
 * locked person out of this counter.
 */
export function SignInScreen({
  state,
  onState,
  api,
  printer,
}: Props & {
  api: ApiReachability | null;
  printer: Printer | null | undefined;
}) {
  const now = useNow();
  const [pin, setPin] = useState("");
  const [switching, setSwitching] = useState(false);
  const { busy, error, run } = useAction();
  const session = state.staffSession;
  const enrollment = state.enrollment;
  const locked = Boolean(session && state.locked);

  function unlock() {
    if (!PIN_OK.test(pin)) return;
    const entered = pin;
    setPin("");
    void run(() => window.pos.unlock({ pin: entered }), onState);
  }

  return (
    <section className={full.screen} aria-label={locked ? "Locked" : "Sign in"}>
      <div className={full.wrap}>
        <div className={full.head}>
          <div className={full.time}>{time(now)}</div>
          <div className={full.date}>
            {longDay(now)}
            {enrollment &&
              ` · ${enrollment.branchName} · ${enrollment.counterLabel}`}
          </div>
        </div>

        {locked && session && !switching ? (
          <div className={cx(full.card, styles.card)}>
            <div className={styles.who}>
              <h2>Who&apos;s at the counter?</h2>
              <p>
                Enter your personal PIN to carry on. Everything you do here is
                recorded in your name.
              </p>
              <div className={styles.staff}>
                <div className={cx(styles.st, styles.sel)}>
                  <Avatar id={session.staffUserId} name={session.staffName} />
                  <div>
                    <b>{session.staffName}</b>
                    <small>Locked this counter</small>
                    <span className={cx(ui.pill, ui.brand)}>
                      Signed in since {time(new Date(session.openedAt))}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  className={styles.st}
                  onClick={() => setSwitching(true)}
                  disabled={busy}
                >
                  <span className={styles.someone}>
                    <Icon name="users" />
                  </span>
                  <div>
                    <b>Someone else</b>
                    <small>Sign in with email and password</small>
                  </div>
                </button>
              </div>
              {state.pin?.lockedUntil && (
                <div
                  role="alert"
                  className={cx(ui.note, ui.noteBad, styles.note)}
                >
                  <Icon name="lock" />
                  <div>
                    <b>This PIN is locked after wrong attempts</b> until{" "}
                    {time(new Date(state.pin.lockedUntil))}. Sign in with email
                    and password instead.
                  </div>
                </div>
              )}
              <div className={styles.foot}>
                Signing in as someone else signs {session.staffName} out of this
                counter.
              </div>
            </div>
            <div className={styles.pin}>
              <Avatar
                id={session.staffUserId}
                name={session.staffName}
                className={styles.big}
              />
              <h3>{session.staffName}</h3>
              <p>Enter your PIN</p>
              <PinPad
                value={pin}
                onChange={setPin}
                onSubmit={unlock}
                busy={busy}
              />
              <ErrorLine error={error} />
              <div className={styles.forgot}>
                Forgot your PIN? Ask a manager to reset it on the web.
              </div>
            </div>
          </div>
        ) : (
          <div className={cx(full.card, styles.single)}>
            <div className={styles.who}>
              {locked && session ? (
                <>
                  <h2>Sign in as someone else</h2>
                  <p>This signs {session.staffName} out of this counter.</p>
                </>
              ) : (
                <>
                  <h2>Staff sign-in</h2>
                  <p>
                    Sign in with your own PharmaCeylon account. Sales and cash
                    are recorded against you.
                  </p>
                </>
              )}
              <div className={styles.form}>
                <SignInForm state={state} onState={onState} />
              </div>
              {locked ? (
                <button
                  type="button"
                  className={cx(ui.btn, ui.ghost, styles.back)}
                  onClick={() => setSwitching(false)}
                >
                  Back to the PIN pad
                </button>
              ) : (
                <div className={styles.foot}>
                  After signing in here once, set a PIN to lock and unlock this
                  counter.
                </div>
              )}
            </div>
          </div>
        )}

        <Chips state={state} api={api} printer={printer} />
      </div>
    </section>
  );
}
