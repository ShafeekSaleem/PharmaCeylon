/**
 * Fixed shell layout for Playwright captures at 1024×640 and 1366×768 (PR #170 item 4).
 * Not shipped in the Electron app — built only as screenshot.html.
 */
import type {
  ApiReachability,
  AppInfo,
  DeviceState,
  JournalSync,
  LocalShift,
  OfflineBackup,
  Printer,
} from "../../shared/ipc-contract";
import { KeyMap, KeyMapProvider } from "./keymap";

const screenshotKeys = new KeyMap();
import sell from "./Sell.module.css";
import { Rail, StatusBar, TitleBar } from "./Shell";
import shell from "./Shell.module.css";
import ui from "./ui.module.css";
import { cx } from "./useAction";
import { emptyEnrollmentOfflineBackup } from "../../shared/ipc-contract";

const ids = {
  ana: "00000000-0000-4000-8000-000000000001",
  branch: "00000000-0000-4000-8000-0000000000b1",
  register: "00000000-0000-4000-8000-0000000000c1",
  till: "00000000-0000-4000-8000-0000000000d1",
  session: "00000000-0000-4000-8000-0000000000e1",
};

const enrollment = {
  status: "active" as const,
  branchId: ids.branch,
  branchName: "Kollupitiya",
  branchCode: "KOL",
  registerId: ids.register,
  tillId: "00000000-0000-4000-8000-0000000000d1",
  counterLabel: "Counter 2",
  label: "Back counter PC",
  terminalId: ids.till,
  enrollmentId: ids.register,
  enrolledAt: "2026-10-14T00:00:00.000Z",
  enrolledByUserId: ids.ana,
  enrolledByName: "Dilini Fernando",
  offlineBackup: emptyEnrollmentOfflineBackup,
  enrollmentFactsLive: true,
  enrollmentStatusFetchedAt: null,
};

const session: NonNullable<DeviceState["staffSession"]> = {
  workSessionId: ids.session,
  staffUserId: ids.ana,
  staffName: "Sachini Rathnayake",
  openedAt: "2026-11-11T08:02:00.000Z",
};

const state: DeviceState = {
  serverUrl: "https://pos.pharmaceylon.lk/api/v1",
  serverUrlEditable: true,
  enrollment,
  operator: null,
  staffSession: session,
  pin: { set: true, prepared: true, lockedUntil: null },
  locked: false,
  counterStaff: [
    {
      staffUserId: ids.ana,
      staffName: "Sachini Rathnayake",
      role: "cashier",
      state: "signed_in",
      lockedUntil: null,
    },
  ],
  branches: [],
  windowsSession: { protocol: "console", remoteSession: false },
};

const api: ApiReachability = {
  reachable: true,
  checkedAt: "2026-11-11T14:32:00.000Z",
  latencyMs: 12,
};

const journal: JournalSync = {
  recorded: 0,
  accepted: 0,
  waiting: 0,
  refused: 0,
  syncing: false,
  lastSuccessAt: "2026-11-11T14:32:08.000Z",
  issue: null,
  pause: null,
  lastDrainAt: null,
};

const shift: LocalShift = {
  workSessionId: ids.session,
  shiftNumber: "S-0412",
  staffUserId: ids.ana,
  staffName: "Sachini Rathnayake",
  openedAt: "2026-11-11T08:02:00.000Z",
  openingCashMinor: 500_000,
  openingCount: [{ denominationMinor: 100_000, count: 5 }],
  status: "open",
  sync: "synced",
  error: null,
  expectedCashMinor: 2_485_000,
  closedAt: null,
  closedByName: null,
  closingCashCountMinor: null,
  serverExpectedCashMinor: null,
  varianceMinor: null,
  varianceNote: null,
  assistanceReason: null,
  needsManagerPin: false,
  summary: null,
  summaryAt: null,
};

const printer: Printer = {
  name: "EPSON_TM_T82III",
  displayName: "EPSON TM-T82III",
};

const info: AppInfo = {
  appVersion: "1.0.0",
  electronVersion: "44.7.0",
  schemaVersion: 15,
  packaged: false,
};

function readyUntilBackup(): OfflineBackup {
  const expires = new Date(2030, 5, 15, 22, 0, 0);
  return {
    grantExpiresAt: expires.toISOString(),
    snapshotGeneratedAt: "2026-11-11T14:30:00.000Z",
    authorizedStaff: 4,
    usable: true,
    failures: 0,
    failure: null,
  };
}

export function ScreenshotShell() {
  return (
    <KeyMapProvider map={screenshotKeys}>
      <div className={shell.win} data-screenshot-shell>
        <TitleBar state={state} api={api} journal={journal} />
        <div className={shell.work}>
          <div className={shell.frame}>
            <Rail
              page="sell"
              onPage={() => undefined}
              workCount={0}
              showWork
              session={session}
              personOpen={false}
              onPerson={() => undefined}
              onLock={() => undefined}
            />
            <main className={shell.content}>
              <div className={shell.page}>
                <div className={sell.sell}>
                  <div className={sell.grid}>
                    <MotionPanel title="Find" rows={["Search products", "All · in stock"]} />
                    <MotionPanel title="Ticket" rows={["Panadol 500mg × 2", "Vitamin C 500mg × 1"]} />
                    <MotionPanel title="Pay" rows={["Rs 1,240.00", "Cash selected"]} />
                  </div>
                </div>
              </div>
            </main>
          </div>
          <StatusBar
            state={state}
            api={api}
            journal={journal}
            offlineBackup={readyUntilBackup()}
            printer={printer}
            info={info}
            shift={shift}
          />
        </div>
      </div>
    </KeyMapProvider>
  );
}

function MotionPanel({
  title,
  rows,
  className,
}: {
  title: string;
  rows: string[];
  className?: string;
}) {
  return (
    <div className={cx(ui.panel, className)}>
      <div className={ui.ph}>
        <h2>{title}</h2>
      </div>
      <MotionUl rows={rows} />
    </div>
  );
}

function MotionUl({ rows }: { rows: string[] }) {
  return (
    <ul style={{ margin: "12px 16px", padding: 0, listStyle: "none", color: "var(--pos-text-2)" }}>
      {rows.map((row) => (
        <li key={row} style={{ padding: "6px 0", borderBottom: "1px solid var(--pos-line)" }}>
          {row}
        </li>
      ))}
    </ul>
  );
}
