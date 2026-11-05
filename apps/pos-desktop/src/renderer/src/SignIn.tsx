import { useRef, useState } from "react";
import type {
  ApiReachability,
  DeviceState,
  LocalShift,
  Printer,
} from "../../shared/ipc-contract";
import { longDay, time, useNow } from "./format";
import { Icon } from "./Icon";
import full from "./Fullscreen.module.css";
import { KeyHint } from "./KeyHint";
import { useKeyBinding } from "./keymap";
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
  submitLabel,
  busy,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  submitLabel: string;
  busy: boolean;
}) {
  const ready = PIN_OK.test(value);
  const pad = useRef<HTMLDivElement>(null);

  // The keyboard's own keys, from anywhere but a field (the keymap's default for these keys).
  // Held keys repeat, as they always have here.
  const keys = { enabled: !busy, repeat: true };
  useKeyBinding(
    "Digit",
    (event) => {
      if (value.length < PIN_MAX) onChange(value + event.key);
    },
    keys,
  );
  useKeyBinding("Backspace", () => onChange(value.slice(0, -1)), keys);
  useKeyBinding(
    ["Enter", "Ctrl+Enter"],
    (event) => {
      // A focused button outside the pad ("Someone else") does its own thing with Enter.
      const target = event.target as HTMLElement | null;
      if (
        !event.ctrlKey &&
        target?.closest("button, a") &&
        !pad.current?.contains(target)
      )
        return false;
      if (ready) onSubmit();
    },
    keys,
  );

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
          aria-label={submitLabel}
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

type CounterPerson = DeviceState["counterStaff"][number];

const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  manager: "Branch manager",
  pharmacist: "Pharmacist",
  cashier: "Cashier",
  inventory_clerk: "Inventory clerk",
  custom: "Custom role",
};

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** Everyone who can sign in here with a PIN, whoever is signed in first. */
function counterPeople(state: DeviceState): CounterPerson[] {
  const session = state.staffSession;
  const others = state.counterStaff.filter(
    (person) => person.staffUserId !== session?.staffUserId,
  );
  if (!session) return others;
  const me = state.counterStaff.find(
    (person) => person.staffUserId === session.staffUserId,
  );
  return [
    me ?? {
      staffUserId: session.staffUserId,
      staffName: session.staffName,
      role: null,
      state: "signed_in",
      lockedUntil: null,
    },
    ...others,
  ];
}

/**
 * The person who opened the shift on this till continues it; anyone else hands over with a cash
 * count first. A close saved here but not confirmed by the server says so.
 */
function ShiftNote({ shift }: { shift: LocalShift }) {
  const name = shift.shiftNumber ? `Shift ${shift.shiftNumber}` : "A shift";
  const first = firstName(shift.staffName);
  if (shift.status === "closing")
    return (
      <div className={cx(ui.note, ui.noteWarn, styles.note)}>
        <Icon name="alert-triangle" />
        <div>
          <b>{name}&apos;s close isn&apos;t confirmed yet.</b> It&apos;s saved
          on this counter and is sent again when{" "}
          {shift.closedByName ? firstName(shift.closedByName) : first} signs
          in.
        </div>
      </div>
    );
  return (
    <div className={cx(ui.note, styles.note)}>
      <Icon name="info" />
      <div>
        <b>{name} is open on this till.</b> {first} continues it. Anyone else
        hands over the shift with a cash count first.
      </div>
    </div>
  );
}

function StaffCard({
  person,
  openedAt,
  shiftSince,
  selected,
  busy,
  onSelect,
}: {
  person: CounterPerson;
  openedAt: string | undefined;
  /** When the shift open on this till began, if it is this person's. */
  shiftSince: string | undefined;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
}) {
  const locked = person.state === "locked" || person.state === "pin_off";
  const role = person.role ? (ROLE_LABELS[person.role] ?? person.role) : null;
  return (
    <button
      type="button"
      className={cx(styles.st, selected && styles.sel, locked && styles.off)}
      aria-pressed={selected}
      onClick={onSelect}
      disabled={busy || locked}
    >
      <Avatar id={person.staffUserId} name={person.staffName} />
      <div>
        <b>{person.staffName}</b>
        {(role || person.state === "signed_in") && (
          <small>{role ?? "Locked this counter"}</small>
        )}
        {shiftSince && !locked ? (
          <span className={cx(ui.pill, ui.brand)}>
            Shift open since {time(new Date(shiftSince))}
          </span>
        ) : person.state === "signed_in" ? (
          <span className={cx(ui.pill, ui.brand)}>
            {openedAt
              ? `Signed in since ${time(new Date(openedAt))}`
              : "Signed in"}
          </span>
        ) : person.state === "pin_off" ? (
          <span className={cx(ui.pill, ui.bad)}>
            <Icon name="lock" />
            PIN off · sign in with password
          </span>
        ) : locked ? (
          <span className={cx(ui.pill, ui.bad)}>
            <Icon name="lock" />
            PIN locked · ask a manager
          </span>
        ) : (
          <span className={cx(ui.pill, ui.ok)}>
            <Icon name="check" />
            Ready on this counter
          </span>
        )}
      </div>
    </button>
  );
}

/**
 * Full screen while nobody is signed in, and the lock screen while someone is. Everyone prepared on
 * this counter is listed: the signed-in person's own PIN unlocks, locally; anyone else's PIN is
 * checked by the server and signs them in in place of whoever was here. Anyone not on the list
 * signs in with their email and password.
 */
export function SignInScreen({
  state,
  onState,
  api,
  printer,
  shift = null,
  suggested = null,
}: Props & {
  api: ApiReachability | null;
  printer: Printer | null | undefined;
  /** The shift open on this till (this counter's copy), if any. */
  shift?: LocalShift | null;
  /** Who to pick first: the person a handover named to take over. */
  suggested?: string | null;
}) {
  const now = useNow();
  const [pin, setPin] = useState("");
  const [switching, setSwitching] = useState(false);
  const [chosen, setChosen] = useState<string | null>(suggested);
  /** Whose PIN the last attempt was, so its refusal stays with them if the list changes. */
  const [tried, setTried] = useState<CounterPerson | null>(null);
  const { busy, error, run, clear } = useAction();
  const session = state.staffSession;
  const enrollment = state.enrollment;
  const locked = Boolean(session && state.locked);
  const people = counterPeople(state);
  const ready = people.filter(
    (person) => person.state === "ready" || person.state === "signed_in",
  );
  const selected =
    ready.find((person) => person.staffUserId === chosen) ?? ready[0] ?? null;
  const unlocking = selected?.staffUserId === session?.staffUserId;

  function choose(person: CounterPerson) {
    setChosen(person.staffUserId);
    setPin("");
    clear();
  }

  function submit() {
    if (!selected || !PIN_OK.test(pin)) return;
    const entered = pin;
    setPin("");
    setTried(selected);
    void run(async () => {
      const result = unlocking
        ? await window.pos.unlock({ pin: entered })
        : await window.pos.pinSignIn({
            staffUserId: selected.staffUserId,
            pin: entered,
          });
      // A refusal can change the list: a locked PIN, or one changed on another counter. If the
      // list can't be read, the refusal is still the thing to show.
      if (!result.ok)
        await window.pos
          .getDeviceState()
          .then(onState)
          .catch(() => undefined);
      return result;
    }, onState);
  }

  // A refusal that took its person off the pad (a locked or stale PIN) is shown with their name,
  // not under whoever the pad moved on to.
  useKeyBinding("Escape", () => setSwitching(false), {
    enabled: Boolean(selected) && switching,
  });

  const strayError =
    error && tried && tried.staffUserId !== selected?.staffUserId
      ? `${tried.staffName}: ${error}`
      : null;

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

        {selected && !switching ? (
          <div className={cx(full.card, styles.card)}>
            <div className={styles.who}>
              <h2>Who&apos;s at the counter?</h2>
              <p>
                Pick your name and enter your personal PIN. Everything you do
                here is recorded in your name.
              </p>
              <div className={styles.staff}>
                {people.map((person) => (
                  <StaffCard
                    key={person.staffUserId}
                    person={person}
                    openedAt={
                      person.staffUserId === session?.staffUserId
                        ? session.openedAt
                        : undefined
                    }
                    shiftSince={
                      shift && shift.staffUserId === person.staffUserId
                        ? shift.openedAt
                        : undefined
                    }
                    selected={person.staffUserId === selected.staffUserId}
                    busy={busy}
                    onSelect={() => choose(person)}
                  />
                ))}
                <button
                  type="button"
                  className={styles.st}
                  onClick={() => {
                    clear();
                    setSwitching(true);
                  }}
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
              {shift && <ShiftNote shift={shift} />}
              {unlocking && state.pin?.lockedUntil ? (
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
              ) : (
                session &&
                !unlocking && (
                  <div className={cx(ui.note, styles.note)}>
                    <Icon name="info" />
                    <div>
                      <b>{session.staffName} is signed in here.</b> Signing in
                      as {firstName(selected.staffName)} signs{" "}
                      {firstName(session.staffName)} out of this counter first.
                    </div>
                  </div>
                )
              )}
              {strayError && (
                <div
                  role="alert"
                  className={cx(ui.note, ui.noteBad, styles.note)}
                >
                  <Icon name="alert-triangle" />
                  <div>{strayError}</div>
                </div>
              )}
              <div className={styles.foot}>
                Not on the list? Sign in with your email and password, then
                prepare your PIN on this counter.
              </div>
            </div>
            <div className={styles.pin}>
              <Avatar
                id={selected.staffUserId}
                name={selected.staffName}
                className={styles.big}
              />
              <h3>{selected.staffName}</h3>
              <p>Enter your PIN</p>
              <PinPad
                value={pin}
                onChange={setPin}
                onSubmit={submit}
                submitLabel={unlocking ? "Unlock" : "Sign in"}
                busy={busy}
              />
              <ErrorLine error={strayError ? null : error} />
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
              {selected ? (
                <button
                  type="button"
                  className={cx(ui.btn, ui.ghost, styles.back)}
                  onClick={() => setSwitching(false)}
                >
                  Back to the PIN pad
                  <KeyHint keys="Escape" />
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
