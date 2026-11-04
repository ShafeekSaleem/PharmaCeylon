import { useCallback, useEffect, useState } from "react";
import type {
  ApiReachability,
  AppInfo,
  DeviceState,
  Printer,
  ReadinessReport,
} from "../../shared/ipc-contract";
import { CounterWork } from "./CounterWork";
import full from "./Fullscreen.module.css";
import { Icon } from "./Icon";
import { KeyBinding, KeyScope } from "./keymap";
import { PersonPanel } from "./Person";
import { Sell } from "./Sell";
import { SetupScreen } from "./Setup";
import { Rail, ServerBlock, StatusBar, TitleBar, type Page } from "./Shell";
import shell from "./Shell.module.css";
import { SignInScreen } from "./SignIn";
import { ThisCounterPage } from "./ThisCounter";
import ui from "./ui.module.css";
import { cx } from "./useAction";

const API_POLL_MS = 15_000;

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [readiness, setReadiness] = useState<ReadinessReport | null>(null);
  const [api, setApi] = useState<ApiReachability | null>(null);
  const [device, setDevice] = useState<DeviceState | null>(null);
  const [deviceFailed, setDeviceFailed] = useState(false);
  /** The printer shown in the status bar: Windows' first. Undefined until the list arrives. */
  const [printer, setPrinter] = useState<Printer | null | undefined>(undefined);
  const [page, setPage] = useState<Page>("sell");
  const [personOpen, setPersonOpen] = useState(false);
  const [workCount, setWorkCount] = useState(0);
  const [lockError, setLockError] = useState<string | null>(null);

  const refreshApi = useCallback(() => {
    window.pos
      .checkApi()
      .then(setApi)
      .catch(() => undefined);
  }, []);

  const loadDevice = useCallback(() => {
    setDeviceFailed(false);
    window.pos
      .getDeviceState()
      .then(setDevice)
      .catch(() => setDeviceFailed(true));
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
    loadDevice();
    window.pos
      .listPrinters()
      .then((list) => setPrinter(list[0] ?? null))
      .catch(() => setPrinter(null));
    refreshApi();
    const timer = window.setInterval(refreshApi, API_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refreshApi, loadDevice]);

  const [commandsSent, setCommandsSent] = useState(0);
  const onCommandSent = useCallback(() => setCommandsSent((n) => n + 1), []);

  const refreshReadiness = useCallback(() => {
    window.pos
      .getReadiness()
      .then(setReadiness)
      .catch(() => undefined);
  }, []);

  // Enrolling, signing in or preparing a PIN changes what the readiness checks can see, and so
  // does a sale or action left unconfirmed.
  useEffect(() => {
    if (device) refreshReadiness();
  }, [device, refreshReadiness]);

  const session = device?.staffSession ?? null;
  const sessionId = session?.workSessionId;
  const pinReady = Boolean(device?.pin?.prepared);

  // Each sign-in opens on Sell. Someone whose PIN isn't set or prepared here gets their panel
  // straight away, since they can't lock the counter without it.
  useEffect(() => {
    setPage("sell");
    setPersonOpen(Boolean(sessionId) && !pinReady);
    // Only a new sign-in does this, not every PIN change.
  }, [sessionId]);

  // Locking from the person's panel leaves it closed for the unlock.
  useEffect(() => {
    if (device?.locked) setPersonOpen(false);
  }, [device?.locked]);

  // A refused lock opens the panel with the reason, so nobody walks away thinking it locked.
  const lock = useCallback(() => {
    setLockError(null);
    if (!pinReady) {
      setPersonOpen(true);
      return;
    }
    const refused = (message: string) => {
      setLockError(message);
      setPersonOpen(true);
    };
    window.pos
      .lock()
      .then((result) =>
        result.ok ? setDevice(result.value) : refused(result.error.message),
      )
      .catch(() => refused("The counter did not lock. Please try again."));
  }, [pinReady]);

  const closePerson = useCallback(() => {
    setPersonOpen(false);
    setLockError(null);
  }, []);

  if (!device)
    return (
      <div className={shell.win}>
        <TitleBar state={null} api={api} />
        {deviceFailed && (
          <section className={full.screen} aria-label="Not started">
            <div className={full.wrap}>
              <div role="alert" className={cx(ui.panel, shell.blockCard)}>
                <span className={cx(ui.kind, shell.blockIcon)}>
                  <Icon name="alert-triangle" />
                </span>
                <h2>This counter couldn&apos;t start</h2>
                <p>
                  It could not read its own settings on this computer. Try
                  again. If it keeps happening, restart the app or call support
                  {info ? ` and give them version ${info.appVersion}` : ""}.
                </p>
                <button
                  type="button"
                  className={cx(ui.btn, ui.outline, ui.lg)}
                  onClick={loadDevice}
                >
                  <Icon name="refresh" />
                  Try again
                </button>
              </div>
            </div>
          </section>
        )}
      </div>
    );

  const active = device.enrollment?.status === "active";
  const signIn = (
    <SignInScreen
      key={sessionId ?? "signed-out"}
      state={device}
      onState={setDevice}
      api={api}
      printer={printer}
    />
  );
  let body;
  if (!active)
    body = (
      <SetupScreen
        state={device}
        onState={setDevice}
        api={api}
        info={info}
        readiness={readiness}
      />
    );
  else if (!session) body = signIn;
  else
    body = (
      <>
        {device.locked && signIn}
        {/* Locking hides the frame rather than closing it, so the sale on screen is still there
            after the unlock. Its keys go quiet with it. */}
        <KeyScope active={!device.locked}>
          <div className={shell.work} hidden={device.locked}>
            <div className={shell.frame}>
              <Rail
                page={page}
                onPage={setPage}
                workCount={workCount}
                showWork={workCount > 0 || page === "work"}
                session={session}
                personOpen={personOpen}
                onPerson={() =>
                  personOpen ? closePerson() : setPersonOpen(true)
                }
                onLock={lock}
              />
              {/* Pages stay mounted while hidden, so moving between them never loses a sale in progress. */}
              <main className={shell.content}>
                {/* Each page's keys work only while it is the one shown. */}
                <KeyScope active={page === "sell"}>
                  <div className={shell.page} hidden={page !== "sell"}>
                    <Sell
                      key={sessionId}
                      onActivity={refreshReadiness}
                      onCommandSent={onCommandSent}
                    />
                  </div>
                </KeyScope>
                <KeyScope active={page === "work"}>
                  <KeyBinding keys="Escape" onKey={() => setPage("sell")} />
                  <div className={shell.page} hidden={page !== "work"}>
                    <CounterWork
                      key={`work-${sessionId}`}
                      onActivity={refreshReadiness}
                      onCount={setWorkCount}
                      reloadKey={commandsSent}
                      poll={!device.locked}
                      you={session.staffName}
                      counterLabel={device.enrollment?.counterLabel ?? null}
                    />
                  </div>
                </KeyScope>
                <KeyScope active={page === "counter"}>
                  <KeyBinding keys="Escape" onKey={() => setPage("sell")} />
                  <div className={shell.page} hidden={page !== "counter"}>
                    <ThisCounterPage
                      state={device}
                      info={info}
                      readiness={readiness}
                      onCheck={refreshReadiness}
                    />
                  </div>
                </KeyScope>
                {api && !api.reachable && page !== "counter" && (
                  <ServerBlock onRetry={refreshApi} />
                )}
              </main>
            </div>
            <StatusBar state={device} api={api} printer={printer} info={info} />
          </div>
        </KeyScope>
        {personOpen && !device.locked && (
          <PersonPanel
            state={device}
            onState={setDevice}
            onClose={closePerson}
            notice={lockError}
          />
        )}
      </>
    );

  return (
    <div className={shell.win}>
      <TitleBar state={device} api={api} />
      {body}
    </div>
  );
}
