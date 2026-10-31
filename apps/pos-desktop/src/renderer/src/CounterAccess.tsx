import { useEffect, useState, type FormEvent } from "react";
import type { ActionResult, Counter, DeviceState } from "../../shared/ipc-contract";
import styles from "./App.module.css";

type Props = { state: DeviceState; onState: (state: DeviceState) => void };

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(action: () => Promise<ActionResult<T>>, onOk: (value: T) => void) {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (result.ok) onOk(result.value);
      else setError(result.error.message);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className={styles.resultFailed}>
      {error}
    </p>
  ) : null;
}

function ServerSetup({ state, onState }: Props) {
  const [url, setUrl] = useState(state.serverUrl ?? "");
  const { busy, error, run } = useAction();
  const [saved, setSaved] = useState(false);
  function submit(event: FormEvent) {
    event.preventDefault();
    setSaved(false);
    void run(
      () => window.pos.setServerUrl({ url }),
      (next) => {
        setSaved(true);
        setUrl(next.serverUrl ?? "");
        onState(next);
      },
    );
  }
  return (
    <form className={styles.form} onSubmit={submit}>
      <label className={styles.field}>
        <span>Server address</span>
        <input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://your-pharmacy.example/api/v1"
          spellCheck={false}
          disabled={busy}
        />
      </label>
      <div className={styles.actions}>
        <button type="submit" className="pc-btn-outline" disabled={busy || !url.trim()}>
          Save server address
        </button>
      </div>
      {saved && <p className={styles.resultOk}>Saved.</p>}
      <ErrorLine error={error} />
    </form>
  );
}

function SignInForm({ onState, title, hint }: Props & { title: string; hint: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { busy, error, run } = useAction();
  function submit(event: FormEvent) {
    event.preventDefault();
    void run(
      () => window.pos.signIn({ email, password }),
      (next) => {
        setPassword("");
        onState(next);
      },
    );
  }
  return (
    <form className={styles.form} onSubmit={submit} aria-labelledby="sign-in-heading">
      <h2 id="sign-in-heading" className={styles.panelTitle}>
        {title}
      </h2>
      <p className="pc-muted">{hint}</p>
      <label className={styles.field}>
        <span>Email</span>
        <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
      </label>
      <label className={styles.field}>
        <span>Password</span>
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
        />
      </label>
      <div className={styles.actions}>
        <button type="submit" className="pc-btn-primary-sm" disabled={busy || !email || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </div>
      <ErrorLine error={error} />
    </form>
  );
}

function EnrollPanel({ state, onState }: Props) {
  const [branchId, setBranchId] = useState(state.branches[0]?.id ?? "");
  const [counters, setCounters] = useState<Counter[] | null>(null);
  const [registerId, setRegisterId] = useState("");
  const [newCounter, setNewCounter] = useState("");
  const [label, setLabel] = useState("");
  const { busy, error, run } = useAction();

  useEffect(() => {
    if (!branchId) return;
    setCounters(null);
    setRegisterId("");
    void run(
      () => window.pos.listCounters({ branchId }),
      (list) => {
        setCounters(list);
        setRegisterId(list.find((c) => c.isActive && !c.terminal)?.registerId ?? "");
      },
    );
    // One load per branch choice.
  }, [branchId]);

  function addCounter() {
    void run(
      () => window.pos.createCounter({ branchId, label: newCounter }),
      (counter) => {
        setCounters((list) => [...(list ?? []), counter]);
        setRegisterId(counter.registerId);
        setNewCounter("");
      },
    );
  }

  function enroll(event: FormEvent) {
    event.preventDefault();
    void run(() => window.pos.enroll({ branchId, registerId, label }), onState);
  }

  function signOut() {
    void run(() => window.pos.signOut(), onState);
  }

  if (state.branches.length === 0)
    return (
      <div className={styles.form}>
        <p>Your account has no branches this counter can be enrolled at.</p>
        <div className={styles.actions}>
          <button type="button" className="pc-btn-outline" onClick={signOut} disabled={busy}>
            Sign out
          </button>
        </div>
        <ErrorLine error={error} />
      </div>
    );

  return (
    <form className={styles.form} onSubmit={enroll} aria-labelledby="enroll-heading">
      <h2 id="enroll-heading" className={styles.panelTitle}>
        Enroll this computer
      </h2>
      <p className="pc-muted">
        Signed in as {state.operator?.fullName}. Enrolling binds this computer to one counter at one branch. Only a
        branch manager can do this, at the computer itself.
      </p>
      <label className={styles.field}>
        <span>Branch</span>
        <select value={branchId} onChange={(e) => setBranchId(e.target.value)} disabled={busy}>
          {state.branches.map((branch) => (
            <option key={branch.id} value={branch.id}>
              {branch.name}
              {branch.code ? ` (${branch.code})` : ""}
            </option>
          ))}
        </select>
      </label>
      <fieldset className={styles.form} disabled={busy}>
        <legend className={styles.field}>Counter</legend>
        {counters === null ? (
          <p className="pc-muted">Loading counters…</p>
        ) : counters.length === 0 ? (
          <p className="pc-muted">This branch has no counters yet. Add one below.</p>
        ) : (
          <ul className={styles.counterList}>
            {counters.map((counter) => {
              const unavailable = !counter.isActive || counter.terminal !== null;
              return (
                <li key={counter.registerId}>
                  <label className={styles.counterOption} aria-disabled={unavailable}>
                    <input
                      type="radio"
                      name="counter"
                      value={counter.registerId}
                      checked={registerId === counter.registerId}
                      onChange={() => setRegisterId(counter.registerId)}
                      disabled={unavailable}
                    />
                    <span>{counter.label}</span>
                    {counter.terminal && <span className="pc-muted">— in use by {counter.terminal.label}</span>}
                    {!counter.isActive && <span className="pc-muted">— switched off</span>}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        <div className={styles.actions}>
          <label className={styles.field}>
            <span>New counter name</span>
            <input value={newCounter} onChange={(e) => setNewCounter(e.target.value)} placeholder="Counter 2" />
          </label>
          <button type="button" className="pc-btn-outline" onClick={addCounter} disabled={!newCounter.trim()}>
            Add counter
          </button>
        </div>
      </fieldset>
      <label className={styles.field}>
        <span>Name for this computer</span>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Front desk PC" disabled={busy} />
      </label>
      <div className={styles.actions}>
        <button type="submit" className="pc-btn-primary-sm" disabled={busy || !registerId || !label.trim()}>
          {busy ? "Working…" : "Enroll this computer"}
        </button>
        <button type="button" className="pc-btn-outline" onClick={signOut} disabled={busy}>
          Cancel and sign out
        </button>
      </div>
      <ErrorLine error={error} />
    </form>
  );
}

function PinField({ label, value, onChange, disabled }: { label: string; value: string; onChange: (v: string) => void; disabled: boolean }) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <input
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={8}
        value={value}
        onChange={(event) => onChange(event.target.value.replace(/\D/g, ""))}
        disabled={disabled}
      />
    </label>
  );
}

const PIN_OK = /^\d{4,8}$/;

function PinSetup({ state, onState, change }: Props & { change: boolean }) {
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
    <form className={styles.form} onSubmit={submit}>
      <h3 className={styles.panelTitle}>{change ? "Change your PIN" : "Set your PIN"}</h3>
      <p className="pc-muted">
        One personal PIN, 4 to 8 digits, for locking this counter and for working here during an internet outage.
        Never share it.
      </p>
      <PinField label="New PIN" value={pin} onChange={setPin} disabled={busy} />
      <PinField label="Repeat the PIN" value={confirm} onChange={setConfirm} disabled={busy} />
      <label className={styles.field}>
        <span>Your login password</span>
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
      </label>
      {mismatch && <p className={styles.resultFailed}>The two PINs are different.</p>}
      <div className={styles.actions}>
        <button type="submit" className="pc-btn-primary-sm" disabled={busy || !PIN_OK.test(pin) || pin !== confirm || !password}>
          Save PIN
        </button>
      </div>
      <ErrorLine error={error} />
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
    <form className={styles.form} onSubmit={submit}>
      <h3 className={styles.panelTitle}>Prepare this counter for your PIN</h3>
      <p className="pc-muted">Enter your PIN once here while online. This counter can then check it on its own.</p>
      <PinField label="Your PIN" value={pin} onChange={setPin} disabled={busy} />
      <div className={styles.actions}>
        <button type="submit" className="pc-btn-primary-sm" disabled={busy || !PIN_OK.test(pin)}>
          Prepare
        </button>
      </div>
      <ErrorLine error={error} />
    </form>
  );
}

function LockScreen({ state, onState }: Props) {
  const [pin, setPin] = useState("");
  const [switching, setSwitching] = useState(false);
  const { busy, error, run } = useAction();
  function submit(event: FormEvent) {
    event.preventDefault();
    void run(
      () => window.pos.unlock({ pin }),
      (next) => {
        setPin("");
        onState(next);
      },
    );
  }
  if (switching)
    return (
      <div className={styles.form}>
        <SignInForm
          state={state}
          onState={onState}
          title="Sign in as someone else"
          hint={`This signs ${state.staffSession?.staffName ?? "the current person"} out of this counter.`}
        />
        <div className={styles.actions}>
          <button type="button" className="pc-btn-outline" onClick={() => setSwitching(false)}>
            Back
          </button>
        </div>
      </div>
    );
  return (
    <form className={styles.form} onSubmit={submit}>
      <h2 className={styles.panelTitle}>Locked</h2>
      <p>{state.staffSession?.staffName} is signed in at this counter.</p>
      <PinField label="PIN" value={pin} onChange={setPin} disabled={busy} />
      <div className={styles.actions}>
        <button type="submit" className="pc-btn-primary-sm" disabled={busy || !PIN_OK.test(pin)}>
          Unlock
        </button>
        <button type="button" className="pc-btn-outline" onClick={() => setSwitching(true)} disabled={busy}>
          Switch user
        </button>
      </div>
      <ErrorLine error={error} />
    </form>
  );
}

function SignedIn({ state, onState }: Props) {
  const { busy, error, run } = useAction();
  const [changing, setChanging] = useState(false);
  const session = state.staffSession!;
  const pin = state.pin;
  if (state.locked) return <LockScreen state={state} onState={onState} />;
  return (
    <div className={styles.form}>
      <h2 className={styles.panelTitle}>Signed in</h2>
      <dl className={styles.facts}>
        <dt>Staff</dt>
        <dd>{session.staffName}</dd>
        <dt>Since</dt>
        <dd>{new Date(session.openedAt).toLocaleTimeString()}</dd>
        <dt>PIN</dt>
        <dd>{!pin?.set ? "Not set" : pin.prepared ? "Ready on this counter" : "Not prepared on this counter"}</dd>
      </dl>
      {pin?.lockedUntil && (
        <p className={styles.resultFailed}>Your PIN is locked after wrong attempts until {new Date(pin.lockedUntil).toLocaleTimeString()}.</p>
      )}
      {(!pin?.set || changing) && (
        <PinSetup
          state={state}
          onState={(next) => {
            setChanging(false);
            onState(next);
          }}
          change={Boolean(pin?.set)}
        />
      )}
      {pin?.set && !pin.prepared && !changing && <PinPrepare state={state} onState={onState} />}
      <div className={styles.actions}>
        {pin?.prepared && (
          <button type="button" className="pc-btn-primary-sm" onClick={() => void run(() => window.pos.lock(), onState)} disabled={busy}>
            Lock
          </button>
        )}
        {pin?.set && !changing && (
          <button type="button" className="pc-btn-outline" onClick={() => setChanging(true)} disabled={busy}>
            Change PIN
          </button>
        )}
        <button type="button" className="pc-btn-outline" onClick={() => void run(() => window.pos.signOut(), onState)} disabled={busy}>
          Sign out
        </button>
      </div>
      <ErrorLine error={error} />
    </div>
  );
}

/** Setup, enrollment and staff sign-in, chosen from the main process's view of this counter. */
export function CounterAccess({ state, onState }: Props) {
  const enrollment = state.enrollment;
  const active = enrollment?.status === "active";
  const remote = state.windowsSession.protocol !== "console" || state.windowsSession.remoteSession;

  return (
    <section className={`${styles.panel} ${styles.wide}`} aria-label="Counter access">
      {remote && (
        <p role="alert" className={styles.resultFailed}>
          This computer is being used remotely or Windows could not confirm its own screen. Enrolling and signing in
          only work at the computer itself.
        </p>
      )}
      {enrollment && (
        <dl className={styles.facts}>
          <dt>Branch</dt>
          <dd>{enrollment.branchName}</dd>
          <dt>Counter</dt>
          <dd>{enrollment.counterLabel}</dd>
          <dt>Computer</dt>
          <dd>{enrollment.label}</dd>
        </dl>
      )}
      {enrollment?.status === "pending" && (
        <p className="pc-muted">Enrollment did not finish. A manager signing in here will complete or cancel it.</p>
      )}
      {(enrollment?.status === "revoked" || enrollment?.status === "retired") && (
        <p className={styles.resultFailed}>
          This counter was switched off in the back office. A manager can sign in to enroll this computer again.
        </p>
      )}

      {state.staffSession ? (
        <SignedIn state={state} onState={onState} />
      ) : state.operator && !active ? (
        <EnrollPanel state={state} onState={onState} />
      ) : active ? (
        <SignInForm
          state={state}
          onState={onState}
          title="Staff sign-in"
          hint="Sign in with your own PharmaCeylon account. Sales and cash are recorded against you."
        />
      ) : (
        <>
          {state.serverUrlEditable && <ServerSetup state={state} onState={onState} />}
          <SignInForm
            state={state}
            onState={onState}
            title="Set up this counter"
            hint="A branch manager signs in here to enroll this computer as a counter."
          />
        </>
      )}
    </section>
  );
}
