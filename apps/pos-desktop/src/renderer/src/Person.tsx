import { useEffect, useState, type FormEvent } from "react";
import type { DeviceState } from "../../shared/ipc-contract";
import { time } from "./format";
import { Icon } from "./Icon";
import styles from "./Person.module.css";
import { atTheComputer, Avatar } from "./Shell";
import { PIN_OK } from "./SignIn";
import ui from "./ui.module.css";
import { cx, ErrorLine, useAction } from "./useAction";

type Props = { state: DeviceState; onState: (state: DeviceState) => void };

function PinField({
  id,
  label,
  value,
  onChange,
  disabled,
  autoFocus,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  autoFocus?: boolean;
}) {
  return (
    <div className={ui.f}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className={ui.in}
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={8}
        value={value}
        onChange={(event) => onChange(event.target.value.replace(/\D/g, ""))}
        disabled={disabled}
        autoFocus={autoFocus}
      />
    </div>
  );
}

function PinSetup({
  onState,
  change,
  onCancel,
}: Props & { change: boolean; onCancel?: () => void }) {
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [password, setPassword] = useState("");
  const { busy, error, run } = useAction();
  const mismatch = confirm.length > 0 && confirm !== pin;
  function submit(event: FormEvent) {
    event.preventDefault();
    void run(
      () => window.pos.setPin({ pin, password }),
      (next) => {
        setPin("");
        setConfirm("");
        setPassword("");
        onState(next);
      },
    );
  }
  return (
    <form className={styles.section} onSubmit={submit}>
      <div>
        <h3>{change ? "Change your PIN" : "Set your PIN"}</h3>
        <p>
          One personal PIN, 4 to 8 digits, for locking this counter and for
          working here during an internet outage. Never share it.
        </p>
      </div>
      <div className={styles.pair}>
        <PinField
          id="pin-new"
          label="New PIN"
          value={pin}
          onChange={setPin}
          disabled={busy}
          autoFocus
        />
        <PinField
          id="pin-repeat"
          label="Repeat the PIN"
          value={confirm}
          onChange={setConfirm}
          disabled={busy}
        />
      </div>
      <div className={ui.f}>
        <label htmlFor="pin-password">Your login password</label>
        <input
          id="pin-password"
          className={ui.in}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
        />
      </div>
      {mismatch && <p className={ui.badText}>The two PINs are different.</p>}
      <ErrorLine error={error} />
      <div className={styles.actions}>
        {onCancel && (
          <button
            type="button"
            className={cx(ui.btn, ui.ghost)}
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          className={cx(ui.btn, ui.primary)}
          disabled={busy || !PIN_OK.test(pin) || pin !== confirm || !password}
        >
          <Icon name="check" />
          Save PIN
        </button>
      </div>
    </form>
  );
}

function PinPrepare({ onState }: Props) {
  const [pin, setPin] = useState("");
  const { busy, error, run } = useAction();
  function submit(event: FormEvent) {
    event.preventDefault();
    void run(
      () => window.pos.preparePin({ pin }),
      (next) => {
        setPin("");
        onState(next);
      },
    );
  }
  return (
    <form className={styles.section} onSubmit={submit}>
      <div>
        <h3>Prepare this counter for your PIN</h3>
        <p>
          Enter your PIN once here while online. This counter can then check it
          on its own.
        </p>
      </div>
      <PinField
        id="pin-prepare"
        label="Your PIN"
        value={pin}
        onChange={setPin}
        disabled={busy}
        autoFocus
      />
      <ErrorLine error={error} />
      <div className={styles.actions}>
        <button
          type="submit"
          className={cx(ui.btn, ui.primary)}
          disabled={busy || !PIN_OK.test(pin)}
        >
          <Icon name="check" />
          Prepare
        </button>
      </div>
    </form>
  );
}

/** The signed-in person's PIN, lock and sign-out, opened from their initials at the foot of the rail. */
export function PersonPanel({
  state,
  onState,
  onClose,
  notice,
}: Props & {
  onClose: () => void;
  /** Why the rail's Lock button didn't lock. */
  notice?: string | null;
}) {
  const { busy, error, run } = useAction();
  const [changing, setChanging] = useState(false);
  const session = state.staffSession!;
  const pin = state.pin;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pinStatus = !pin?.set
    ? "Not set"
    : pin.prepared
      ? "Ready on this counter"
      : "Not prepared on this counter";
  return (
    <>
      <div className={styles.scrim} onClick={onClose} />
      <div
        className={cx(ui.panel, styles.panel)}
        role="dialog"
        aria-label={session.staffName}
      >
        <div className={styles.head}>
          <Avatar
            id={session.staffUserId}
            name={session.staffName}
            className={styles.av}
          />
          <div>
            <b>{session.staffName}</b>
            <small>
              Signed in since {time(new Date(session.openedAt))}
              {atTheComputer(state) ? " · at the counter" : " · remote session"}
            </small>
          </div>
        </div>
        <div className={styles.body}>
          <div className={ui.kvs}>
            <div className={ui.kv}>
              PIN
              <b>
                <span className={cx(ui.pill, pin?.prepared ? ui.ok : ui.warn)}>
                  {pin?.prepared && <Icon name="check" />}
                  {pinStatus}
                </span>
              </b>
            </div>
          </div>
          {pin?.lockedUntil && (
            <div role="alert" className={cx(ui.note, ui.noteBad)}>
              <Icon name="lock" />
              <div>
                Your PIN is locked after wrong attempts until{" "}
                {time(new Date(pin.lockedUntil))}.
              </div>
            </div>
          )}
          {(!pin?.set || changing) && (
            <PinSetup
              state={state}
              onState={(next) => {
                setChanging(false);
                onState(next);
              }}
              change={Boolean(pin?.set)}
              onCancel={changing ? () => setChanging(false) : undefined}
            />
          )}
          {pin?.set && !pin.prepared && !changing && (
            <PinPrepare state={state} onState={onState} />
          )}
          <ErrorLine error={error ?? notice ?? null} />
        </div>
        <div className={ui.dfoot}>
          <button
            type="button"
            className={cx(ui.btn, ui.ghost)}
            onClick={() => void run(() => window.pos.signOut(), onState)}
            disabled={busy}
          >
            <Icon name="log-out" />
            Sign out
          </button>
          <span className={ui.grow} />
          {pin?.set && !changing && (
            <button
              type="button"
              className={cx(ui.btn, ui.outline)}
              onClick={() => setChanging(true)}
              disabled={busy}
            >
              Change PIN
            </button>
          )}
          {pin?.prepared && (
            <button
              type="button"
              className={cx(ui.btn, ui.primary)}
              onClick={() => void run(() => window.pos.lock(), onState)}
              disabled={busy}
            >
              <Icon name="lock" />
              Lock
            </button>
          )}
        </div>
      </div>
    </>
  );
}
