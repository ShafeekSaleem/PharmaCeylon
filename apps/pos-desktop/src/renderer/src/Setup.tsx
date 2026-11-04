import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  ApiReachability,
  AppInfo,
  Counter,
  DeviceState,
  ReadinessReport,
} from "../../shared/ipc-contract";
import { Icon } from "./Icon";
import full from "./Fullscreen.module.css";
import { KeyHint } from "./KeyHint";
import { clickSubmit, useKeyBinding } from "./keymap";
import { atTheComputer } from "./Shell";
import styles from "./Setup.module.css";
import ui from "./ui.module.css";
import { cx, ErrorLine, useAction } from "./useAction";

type Props = { state: DeviceState; onState: (state: DeviceState) => void };

/** Email and password, for setting a counter up and for each person's first sign-in on it. */
export function SignInForm({
  onState,
  submitLabel = "Sign in",
}: Props & { submitLabel?: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { busy, error, run } = useAction();
  const form = useRef<HTMLFormElement>(null);
  useKeyBinding("Ctrl+Enter", () => clickSubmit(form.current));
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
    <form className={styles.fields} onSubmit={submit} ref={form}>
      <div className={ui.f}>
        <label htmlFor="sign-in-email">Email</label>
        <input
          id="sign-in-email"
          className={ui.in}
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
        />
      </div>
      <div className={ui.f}>
        <label htmlFor="sign-in-password">Password</label>
        <input
          id="sign-in-password"
          className={ui.in}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
        />
      </div>
      <ErrorLine error={error} />
      <div>
        <button
          type="submit"
          className={cx(ui.btn, ui.primary, ui.lg)}
          disabled={busy || !email || !password}
        >
          {busy ? "Signing in…" : submitLabel}
          <Icon name="arrow-right" />
          <KeyHint keys="Ctrl+Enter" onPrimary />
        </button>
      </div>
    </form>
  );
}

function ServerSetup({
  state,
  onState,
  onDone,
}: Props & { onDone: () => void }) {
  const [url, setUrl] = useState(state.serverUrl ?? "");
  const { busy, error, run } = useAction();
  const form = useRef<HTMLFormElement>(null);
  useKeyBinding("Ctrl+Enter", () => clickSubmit(form.current));
  function submit(event: FormEvent) {
    event.preventDefault();
    void run(
      () => window.pos.setServerUrl({ url }),
      (next) => {
        setUrl(next.serverUrl ?? "");
        onState(next);
        onDone();
      },
    );
  }
  return (
    <form className={styles.fields} onSubmit={submit} ref={form}>
      <div className={ui.f}>
        <label htmlFor="server-url">Server address</label>
        <input
          id="server-url"
          className={cx(ui.in, ui.mono)}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://your-pharmacy.example/api/v1"
          spellCheck={false}
          disabled={busy}
        />
      </div>
      <ErrorLine error={error} />
      <div>
        <button
          type="submit"
          className={cx(ui.btn, ui.primary, ui.lg)}
          disabled={busy || !url.trim()}
        >
          Save server address
          <KeyHint keys="Ctrl+Enter" onPrimary />
        </button>
      </div>
    </form>
  );
}

function EnrollPanel({ state, onState }: Props) {
  const [mode, setMode] = useState<"code" | "counter">("counter");
  const [code, setCode] = useState("");
  const [branchId, setBranchId] = useState(state.branches[0]?.id ?? "");
  const [counters, setCounters] = useState<Counter[] | null>(null);
  const [registerId, setRegisterId] = useState("");
  const [adding, setAdding] = useState(false);
  const [newCounter, setNewCounter] = useState("");
  const [label, setLabel] = useState("");
  const { busy, error, run } = useAction();
  const form = useRef<HTMLFormElement>(null);
  // Ctrl+Enter sends the form from anywhere on the step, as the button's key hint says. Plain
  // Enter in the new counter's name adds the counter instead (its own onKeyDown, below).
  useKeyBinding("Ctrl+Enter", () => clickSubmit(form.current));
  useKeyBinding("Escape", () => setAdding(false), { enabled: adding });

  useEffect(() => {
    if (!branchId || mode !== "counter") return;
    setCounters(null);
    setRegisterId("");
    void run(
      () => window.pos.listCounters({ branchId }),
      (list) => {
        setCounters(list);
        setRegisterId(
          list.find((c) => c.isActive && !c.terminal)?.registerId ?? "",
        );
      },
    );
    // One load per branch choice.
  }, [branchId, mode]);

  function addCounter() {
    void run(
      () => window.pos.createCounter({ branchId, label: newCounter }),
      (counter) => {
        setCounters((list) => [...(list ?? []), counter]);
        setRegisterId(counter.registerId);
        setNewCounter("");
        setAdding(false);
      },
    );
  }

  const canEnroll =
    Boolean(label.trim()) &&
    (mode === "code" ? code.trim().length >= 4 : Boolean(registerId));

  function enroll(event: FormEvent) {
    event.preventDefault();
    if (busy || !canEnroll) return;
    if (mode === "code")
      void run(
        () => window.pos.enrollWithCode({ branchId, code, label }),
        onState,
      );
    else
      void run(
        () => window.pos.enroll({ branchId, registerId, label }),
        onState,
      );
  }

  function signOut() {
    void run(() => window.pos.signOut(), onState);
  }

  const branch = state.branches.find((b) => b.id === branchId);

  if (state.branches.length === 0)
    return (
      <div className={styles.form}>
        <StepHead step="Step 3 of 4" title="Enroll this computer" />
        <div className={cx(ui.note, ui.noteWarn)}>
          <Icon name="alert-triangle" />
          <div>
            Your account has no branches this counter can be enrolled at.
          </div>
        </div>
        <ErrorLine error={error} />
        <div className={cx(ui.dfoot, styles.foot)}>
          <button
            type="button"
            className={cx(ui.btn, ui.ghost, ui.lg)}
            onClick={signOut}
            disabled={busy}
          >
            <Icon name="log-out" />
            Sign out
          </button>
        </div>
      </div>
    );

  return (
    <form className={styles.form} onSubmit={enroll} ref={form}>
      <StepHead
        step="Step 3 of 4"
        title="Enroll this computer"
        text={`Signed in as ${state.operator?.fullName ?? "you"}. Enrolling ties this computer to one counter at one branch. It only works at the computer itself, not over a remote connection.`}
      />
      <div
        className={cx(ui.seg, styles.seg)}
        role="group"
        aria-label="How to enroll"
      >
        <button
          type="button"
          aria-pressed={mode === "counter"}
          onClick={() => setMode("counter")}
          disabled={busy}
        >
          <Icon name="users" />
          I&apos;m a manager
        </button>
        <button
          type="button"
          aria-pressed={mode === "code"}
          onClick={() => setMode("code")}
          disabled={busy}
        >
          <Icon name="lock" />I have an enrollment code
        </button>
      </div>
      <p className={styles.hint}>
        A manager picks the counter here. Anyone else signs in with their own
        account and enters a one-time code that a manager creates on the web, in
        Settings → Counters &amp; devices.
      </p>
      <div className={ui.f}>
        <label htmlFor="enroll-branch">Branch</label>
        <div className={ui.select}>
          <select
            id="enroll-branch"
            className={ui.in}
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
            disabled={busy}
          >
            {state.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
                {b.code ? ` (${b.code})` : ""}
              </option>
            ))}
          </select>
          <Icon name="chevron-down" />
        </div>
      </div>
      {mode === "code" ? (
        <div className={ui.f}>
          <label htmlFor="enroll-code">Enrollment code from your manager</label>
          <input
            id="enroll-code"
            className={cx(ui.in, ui.mono)}
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="XXXXX-XXXXX"
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
          />
        </div>
      ) : (
        <fieldset className={styles.counterSet} disabled={busy}>
          <legend className={ui.label}>
            Counter
            {counters && counters.length > 0 && (
              <span>
                {counters.length} at {branch?.name ?? "this branch"}
              </span>
            )}
          </legend>
          {counters === null ? (
            <p className={ui.muted}>Loading counters…</p>
          ) : (
            <div className={styles.ctrs}>
              {counters.length === 0 && (
                <p className={ui.muted}>
                  This branch has no counters yet. Add one below.
                </p>
              )}
              {counters.map((counter) => {
                const unavailable =
                  !counter.isActive || counter.terminal !== null;
                const selected = registerId === counter.registerId;
                return (
                  <label
                    key={counter.registerId}
                    className={cx(
                      styles.ctr,
                      selected && styles.ctrSel,
                      unavailable && styles.ctrOff,
                    )}
                    aria-disabled={unavailable}
                  >
                    <input
                      type="radio"
                      name="counter"
                      value={counter.registerId}
                      checked={selected}
                      onChange={() => setRegisterId(counter.registerId)}
                      disabled={unavailable}
                    />
                    <b>{counter.label}</b>
                    {counter.terminal ? (
                      <span className={cx(ui.pill, ui.neutral)}>
                        In use by {counter.terminal.label}
                      </span>
                    ) : !counter.isActive ? (
                      <span className={cx(ui.pill, ui.neutral)}>
                        Switched off
                      </span>
                    ) : (
                      <span className={cx(ui.pill, ui.ok)}>
                        <Icon name="check" />
                        Free
                      </span>
                    )}
                  </label>
                );
              })}
              {adding ? (
                <div className={cx(styles.ctr, styles.ctrAdd)}>
                  <Icon name="plus" />
                  <input
                    className={cx(ui.in, styles.addInput)}
                    value={newCounter}
                    onChange={(e) => setNewCounter(e.target.value)}
                    placeholder="Counter name, for example Counter 4"
                    aria-label="New counter name"
                    autoFocus
                    onKeyDown={(event) => {
                      // Enter here adds the counter; only Ctrl+Enter sends the whole form.
                      if (event.key !== "Enter" || event.ctrlKey) return;
                      event.preventDefault();
                      if (newCounter.trim()) addCounter();
                    }}
                  />
                  <button
                    type="button"
                    className={cx(ui.btn, ui.outline, ui.sm)}
                    onClick={addCounter}
                    disabled={!newCounter.trim()}
                  >
                    Add counter
                  </button>
                  <button
                    type="button"
                    className={cx(ui.btn, ui.ghost, ui.sm)}
                    onClick={() => setAdding(false)}
                  >
                    Cancel
                    <KeyHint keys="Escape" small />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className={cx(styles.ctr, styles.ctrAdd)}
                  onClick={() => setAdding(true)}
                >
                  <Icon name="plus" />
                  Add a counter at this branch
                </button>
              )}
            </div>
          )}
        </fieldset>
      )}
      <div className={ui.f}>
        <label htmlFor="enroll-label" className={ui.label}>
          Name for this computer{" "}
          <span>Shown on the web, in Counters &amp; devices</span>
        </label>
        <input
          id="enroll-label"
          className={ui.in}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Front desk PC"
          disabled={busy}
        />
      </div>
      <ErrorLine error={error} />
      <div className={cx(ui.dfoot, styles.foot)}>
        <button
          type="button"
          className={cx(ui.btn, ui.ghost, ui.lg)}
          onClick={signOut}
          disabled={busy}
        >
          <Icon name="log-out" />
          Cancel and sign out
        </button>
        <span className={ui.grow} />
        <button
          type="submit"
          className={cx(ui.btn, ui.primary, ui.lg)}
          disabled={busy || !canEnroll}
        >
          <Icon name="monitor" />
          {busy ? "Working…" : "Enroll this computer"}
          <KeyHint keys="Ctrl+Enter" onPrimary />
        </button>
      </div>
    </form>
  );
}

function StepHead({
  step,
  title,
  text,
}: {
  step: string;
  title: string;
  text?: string;
}) {
  return (
    <div>
      <div className={ui.eyebrow}>{step}</div>
      <h2 className={styles.title}>{title}</h2>
      {text && <p className={styles.text}>{text}</p>}
    </div>
  );
}

/** Why this computer can't sell, from its enrollment as last confirmed with the server. */
function EnrollmentNotice({ state }: { state: DeviceState }) {
  const status = state.enrollment?.status;
  const remote = !atTheComputer(state);
  if (
    !remote &&
    status !== "pending" &&
    status !== "revoked" &&
    status !== "retired"
  )
    return null;
  return (
    <div className={styles.notices}>
      {remote && (
        <div role="alert" className={cx(ui.note, ui.noteBad)}>
          <Icon name="alert-triangle" />
          <div>
            This computer is being used remotely or Windows could not confirm
            its own screen. Enrolling and signing in only work at the computer
            itself.
          </div>
        </div>
      )}
      {status === "pending" && (
        <div className={cx(ui.note, ui.noteWarn)}>
          <Icon name="alert-triangle" />
          <div>
            Enrollment did not finish. A manager signing in here will complete
            or cancel it.
          </div>
        </div>
      )}
      {status === "revoked" && (
        <div role="alert" className={cx(ui.note, ui.noteBad)}>
          <Icon name="alert-triangle" />
          <div>
            <b>This counter is switched off.</b> This computer&apos;s key was
            revoked in the back office, so it can&apos;t sell. It still holds
            its counter: to use it again, a manager retires it in Settings →
            Counters &amp; devices, then signs in here to enroll it again.
          </div>
        </div>
      )}
      {status === "retired" && (
        <div role="alert" className={cx(ui.note, ui.noteBad)}>
          <Icon name="alert-triangle" />
          <div>
            <b>This computer was retired in the back office.</b> A manager can
            sign in to enroll it again.
          </div>
        </div>
      )}
    </div>
  );
}

/** Full screen while this computer isn't an active counter: there's no menu, because nobody can sign in yet. */
export function SetupScreen({
  state,
  onState,
  api,
  info,
  readiness,
}: Props & {
  api: ApiReachability | null;
  info: AppInfo | null;
  readiness: ReadinessReport | null;
}) {
  const [editingServer, setEditingServer] = useState(false);
  const { busy, error, run } = useAction();
  const serverStep =
    state.serverUrlEditable && (!state.serverUrl || editingServer);
  // Esc goes back from changing a saved server address to the step it came from.
  useKeyBinding("Escape", () => setEditingServer(false), {
    enabled: serverStep && Boolean(state.serverUrl),
  });
  const current = serverStep ? 1 : state.operator ? 3 : 2;
  const credentialCheck = readiness?.checks.find(
    (c) => c.id === "credential-store",
  );
  const atComputer = atTheComputer(state);

  const steps = [
    {
      title: "Server address",
      detail: state.serverUrl ?? "Where this pharmacy's PharmaCeylon server is",
      mono: Boolean(state.serverUrl),
    },
    {
      title: "Sign in",
      detail: state.operator
        ? state.operator.fullName
        : "A manager, or someone with a code",
    },
    {
      title: "Enroll this computer",
      detail: "Choose the branch and the counter",
    },
    {
      title: "Staff sign in",
      detail:
        "Each person signs in here once while online to set or prepare their PIN",
    },
  ];

  return (
    <section className={full.screen} aria-label="Set up this counter">
      <div className={full.wrap}>
        <div className={full.head}>
          <h1>Set up this counter</h1>
          <p>
            This computer isn&apos;t a counter yet. A branch manager, or someone
            with a one-time code, sets it up once.
          </p>
        </div>
        <div className={cx(full.card, styles.card)}>
          <div className={styles.steps}>
            <div className={ui.eyebrow}>Setup steps</div>
            <ol className={styles.list}>
              {steps.map((step, index) => {
                const n = index + 1;
                const done = n < current;
                return (
                  <li
                    key={step.title}
                    className={cx(
                      done && styles.done,
                      n === current && styles.now,
                    )}
                  >
                    <i>{done ? <Icon name="check" /> : n}</i>
                    <div>
                      <b>{step.title}</b>
                      <small className={step.mono ? ui.mono : undefined}>
                        {step.detail}
                      </small>
                    </div>
                    {n === 1 &&
                      done &&
                      state.serverUrlEditable &&
                      !state.operator && (
                        <button
                          type="button"
                          className={cx(ui.btn, ui.ghost, ui.sm)}
                          onClick={() => setEditingServer(true)}
                        >
                          Change
                        </button>
                      )}
                  </li>
                );
              })}
            </ol>
            <div className={cx(ui.note, styles.after)}>
              <Icon name="info" />
              <div>
                <b>Afterwards</b>, test the receipt printer on the This counter
                page. The offline backup is chosen by the owner on the web.
              </div>
            </div>
          </div>

          <div className={styles.pane}>
            <EnrollmentNotice state={state} />
            {state.staffSession ? (
              <div className={styles.form}>
                <StepHead
                  step="Signed in"
                  title={`${state.staffSession.staffName} is signed in`}
                  text="Sign out, then a manager can sign in here to set this computer up again."
                />
                <ErrorLine error={error} />
                <div className={cx(ui.dfoot, styles.foot)}>
                  <button
                    type="button"
                    className={cx(ui.btn, ui.outline, ui.lg)}
                    onClick={() =>
                      void run(() => window.pos.signOut(), onState)
                    }
                    disabled={busy}
                  >
                    <Icon name="log-out" />
                    Sign out
                  </button>
                </div>
              </div>
            ) : current === 1 ? (
              <div className={styles.form}>
                <StepHead
                  step="Step 1 of 4"
                  title="Server address"
                  text="The address of this pharmacy's PharmaCeylon server. Your manager or support has it."
                />
                <ServerSetup
                  state={state}
                  onState={onState}
                  onDone={() => setEditingServer(false)}
                />
              </div>
            ) : current === 2 ? (
              <div className={styles.form}>
                <StepHead
                  step="Step 2 of 4"
                  title="Sign in"
                  text="Sign in with your own PharmaCeylon account. A branch manager can enroll this computer directly; anyone else needs a one-time code from a manager."
                />
                <SignInForm state={state} onState={onState} />
              </div>
            ) : (
              <EnrollPanel state={state} onState={onState} />
            )}
          </div>
        </div>
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
          <span className={cx(ui.pill, atComputer ? ui.ok : ui.bad)}>
            <Icon name="monitor" />
            {atComputer
              ? "At the computer · console session"
              : "Remote session"}
          </span>
          {credentialCheck && (
            <span
              className={cx(
                ui.pill,
                credentialCheck.status === "ok" ? ui.ok : ui.bad,
              )}
            >
              <Icon name="shield-check" />
              {credentialCheck.status === "ok"
                ? "Windows credential protection ready"
                : "Windows credential protection not available"}
            </span>
          )}
          {info && (
            <span className={cx(ui.pill, ui.neutral)}>v{info.appVersion}</span>
          )}
        </div>
      </div>
    </section>
  );
}
