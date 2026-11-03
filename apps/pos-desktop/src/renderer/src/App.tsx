import { useCallback, useEffect, useState } from "react";
import type {
  ApiReachability,
  AppInfo,
  DeviceState,
  Printer,
  ReadinessReport,
} from "../../shared/ipc-contract";
import { Checkout } from "./Checkout";
import { CounterWork } from "./CounterWork";
import { Icon } from "./Icon";
import { PersonPanel } from "./Person";
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
  /** The printer checkout prints to: Windows' first. Undefined until the list arrives. */
  const [printer, setPrinter] = useState<Printer | null | undefined>(undefined);
  const [page, setPage] = useState<Page>("sell");
  const [personOpen, setPersonOpen] = useState(false);
  const [workCount, setWorkCount] = useState(0);

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
    window.pos
      .getDeviceState()
      .then(setDevice)
      .catch(() => undefined);
    window.pos
      .listPrinters()
      .then((list) => setPrinter(list[0] ?? null))
      .catch(() => setPrinter(null));
    refreshApi();
    const timer = window.setInterval(refreshApi, API_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refreshApi]);

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

  const lock = useCallback(() => {
    if (!pinReady) {
      setPersonOpen(true);
      return;
    }
    window.pos
      .lock()
      .then((result) =>
        result.ok ? setDevice(result.value) : setPersonOpen(true),
      )
      .catch(() => undefined);
  }, [pinReady]);

  if (!device)
    return (
      <div className={shell.win}>
        <TitleBar state={null} api={api} />
      </div>
    );

  const active = device.enrollment?.status === "active";
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
  else if (!session || device.locked)
    body = (
      <SignInScreen
        key={sessionId ?? "signed-out"}
        state={device}
        onState={setDevice}
        api={api}
        printer={printer}
      />
    );
  else
    body = (
      <>
        <div className={shell.frame}>
          <Rail
            page={page}
            onPage={setPage}
            workCount={workCount}
            showWork={workCount > 0 || page === "work"}
            session={session}
            personOpen={personOpen}
            onPerson={() => setPersonOpen((open) => !open)}
            onLock={lock}
          />
          {/* Pages stay mounted while hidden, so moving between them never loses a sale in progress. */}
          <main className={shell.content}>
            <div className={shell.page} hidden={page !== "sell"}>
              <Checkout
                key={sessionId}
                onActivity={refreshReadiness}
                onCommandSent={onCommandSent}
              />
            </div>
            <div className={shell.page} hidden={page !== "work"}>
              <div className={ui.pageH}>
                <div>
                  <h1>Counter work</h1>
                  <p>
                    Refunds approved on the web, and actions sent from here that
                    still need confirming.
                  </p>
                </div>
              </div>
              {workCount === 0 && (
                <div className={cx(ui.panel, shell.empty)}>
                  <Icon name="inbox" />
                  Nothing is waiting at this counter.
                </div>
              )}
              <CounterWork
                key={`work-${sessionId}`}
                onActivity={refreshReadiness}
                onCount={setWorkCount}
                reloadKey={commandsSent}
              />
            </div>
            <div className={shell.page} hidden={page !== "counter"}>
              <ThisCounterPage
                state={device}
                info={info}
                readiness={readiness}
                onCheck={refreshReadiness}
              />
            </div>
            {api && !api.reachable && page !== "counter" && (
              <ServerBlock onRetry={refreshApi} />
            )}
          </main>
        </div>
        <StatusBar state={device} api={api} printer={printer} info={info} />
        {personOpen && (
          <PersonPanel
            state={device}
            onState={setDevice}
            onClose={() => setPersonOpen(false)}
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
