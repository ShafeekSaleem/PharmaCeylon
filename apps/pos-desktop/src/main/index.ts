import { app, BrowserWindow, dialog, Menu, net, safeStorage, session } from "electron";
import { join } from "node:path";
import type { ActionResult } from "../shared/ipc-contract";
import { ApiSession } from "./api/api-client";
import { checkApi } from "./api-check";
import { classifyWindowsSession, createWindowsSessionReader } from "./attendance/windows-session";
import type { SecretProtector } from "./db/key-store";
import { migrations } from "./db/migrations";
import { registerIpcHandlers } from "./ipc/handle";
import { openLocalStore, type LocalStore } from "./local-store";
import { createLogger } from "./logging/logger";
import { printTestReceipt } from "./printing/test-receipt";
import { buildReadinessReport } from "./readiness";
import { isAppUrl } from "./renderer-path";
import { hardenSession, hardenWebContents, mainFetch, registerAppScheme, serveRenderer } from "./security";
import { normalizeServerUrl, readServerUrl, writeServerUrl } from "./server-url";
import { runSmokeTest } from "./smoke";
import { DeviceStore } from "./device/device-store";
import { PinStore } from "./staff/pin-store";
import { ActionFailure, explain, TerminalService } from "./terminal/terminal-service";
import { createMainWindow } from "./window";

const smokeMode = process.argv.includes("--smoke-test");
if (smokeMode) {
  // The smoke test writes rows; it must never run against a real till's data.
  if (!process.env.POS_SMOKE_DIR) app.exit(2);
  else app.setPath("userData", process.env.POS_SMOKE_DIR);
}

// The dev server only exists under `electron-vite dev`; a packaged build always
// loads its own bundled renderer.
const devServerUrl = app.isPackaged ? null : (process.env.ELECTRON_RENDERER_URL ?? null);
const devServerOrigin = devServerUrl ? new URL(devServerUrl).origin : null;

// Before enrollment the server address comes from setup (saved in the local database), then the
// environment, then the local Nest port in development. An enrolled counter uses the address it
// enrolled against.
const defaultApiBaseUrl = process.env.POS_API_BASE_URL ?? (app.isPackaged ? null : "http://127.0.0.1:3001/api/v1");
const readWindowsSession = createWindowsSessionReader();

// DPAPI, via Electron: the blob can only be opened by this Windows user on this machine.
const protector: SecretProtector = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  protect: (plain) => safeStorage.encryptString(plain),
  unprotect: (blob) => safeStorage.decryptString(blob),
};

let mainWindow: BrowserWindow | null = null;
let store: LocalStore | null = null;
let terminal: TerminalService | null = null;

function currentApiBaseUrl(): string | null {
  if (!store) return defaultApiBaseUrl;
  return new DeviceStore(store.db).read()?.apiBaseUrl ?? readServerUrl(store.db) ?? defaultApiBaseUrl;
}

/** Runs a renderer-requested action; refusals come back as explained data, details go to the log. */
async function act<T>(
  logger: ReturnType<typeof createLogger>,
  name: string,
  run: (service: TerminalService) => Promise<T> | T,
): Promise<ActionResult<T>> {
  if (!terminal) return { ok: false, error: { code: "NOT_READY", message: "The counter is still starting." } };
  try {
    return { ok: true, value: await run(terminal) };
  } catch (error) {
    const explained = explain(error);
    logger.warn("terminal.action_refused", { action: name, code: explained.code });
    return { ok: false, error: explained };
  }
}

function registerIpc(schemaVersion: number, logger: ReturnType<typeof createLogger>): void {
  registerIpcHandlers(
    {
      getAppInfo: () => ({
        appVersion: app.getVersion(),
        electronVersion: process.versions.electron ?? "",
        schemaVersion,
        packaged: app.isPackaged,
      }),
      getReadiness: () =>
        buildReadinessReport(
          {
            databaseOpen: store?.db.open ?? false,
            schemaVersion,
            latestSchemaVersion: migrations.length,
            credentialStoreAvailable: protector.isAvailable(),
            enrollmentStatus: store ? (new DeviceStore(store.db).read()?.status ?? null) : null,
          },
          new Date(),
        ),
      checkApi: () => checkApi(currentApiBaseUrl(), mainFetch),
      listPrinters: async () => {
        const printers = (await mainWindow?.webContents.getPrintersAsync()) ?? [];
        return printers.map((printer) => ({
          name: printer.name,
          displayName: printer.displayName || printer.name,
        }));
      },
      printTestReceipt: ({ printerName }) => printTestReceipt(printerName, app.getVersion()),
      getDeviceState: () => {
        if (terminal) return terminal.state();
        const windows = classifyWindowsSession(readWindowsSession());
        return {
          serverUrl: currentApiBaseUrl(),
          serverUrlEditable: false,
          enrollment: null,
          operator: null,
          staffSession: null,
          pin: null,
          locked: false,
          branches: [],
          windowsSession: { protocol: windows.protocol, remoteSession: windows.remoteSession },
        };
      },
      setServerUrl: ({ url }) =>
        act(logger, "setServerUrl", (service) => {
          if (!store) throw new ActionFailure("NOT_READY", "The counter is still starting.");
          if (new DeviceStore(store.db).read())
            throw new ActionFailure("ALREADY_ENROLLED", "An enrolled counter keeps the server it enrolled with.");
          writeServerUrl(store.db, normalizeServerUrl(url, app.isPackaged), new Date());
          return service.state();
        }),
      signIn: ({ email, password }) => act(logger, "signIn", (service) => service.signIn(email, password)),
      signOut: () => act(logger, "signOut", (service) => service.signOut()),
      refreshEnrollment: () => act(logger, "refreshEnrollment", (service) => service.refreshStatus()),
      listCounters: ({ branchId }) => act(logger, "listCounters", (service) => service.listCounters(branchId)),
      createCounter: ({ branchId, label }) =>
        act(logger, "createCounter", (service) => service.createCounter(branchId, label)),
      enroll: (input) => act(logger, "enroll", (service) => service.enroll(input)),
      enrollWithCode: (input) => act(logger, "enrollWithCode", (service) => service.enrollWithCode(input)),
      offlineCounter: () => act(logger, "offlineCounter", (service) => service.offlineCounter()),
      activateOffline: ({ authorizationId }) =>
        act(logger, "activateOffline", (service) => service.activateOffline(authorizationId)),
      setPin: ({ pin, password }) => act(logger, "setPin", (service) => service.setPin(pin, password)),
      preparePin: ({ pin }) => act(logger, "preparePin", (service) => service.preparePin(pin)),
      lock: () => act(logger, "lock", (service) => service.lock()),
      unlock: ({ pin }) => act(logger, "unlock", (service) => service.unlock(pin)),
    },
    { isTrustedSender: (url) => isAppUrl(url, devServerOrigin), logger },
  );
}

async function start(): Promise<void> {
  const logger = createLogger(join(app.getPath("userData"), "logs"));
  const dataDir = join(app.getPath("userData"), "data");

  hardenSession(session.defaultSession, devServerOrigin);
  if (!devServerUrl) serveRenderer(join(__dirname, "../renderer"));
  if (app.isPackaged) Menu.setApplicationMenu(null);

  if (smokeMode) {
    const result = await runSmokeTest({ dataDir, protector, registerIpc: (version) => registerIpc(version, logger) });
    await logger.flush();
    app.exit(result.ok ? 0 : 1);
    return;
  }

  try {
    store = openLocalStore(dataDir, protector, migrations);
  } catch (error) {
    // Unsafe to continue: no window is created, so nothing can be sold
    // against a database that is missing, unreadable or half-upgraded.
    logger.error("startup.local_store_failed", { error });
    await logger.flush();
    dialog.showErrorBox(
      "Curalio POS cannot start",
      `${error instanceof Error ? error.message : "The local database could not be opened."}\n\n` +
        "Do not delete or move any files. Contact support.",
    );
    app.exit(1);
    return;
  }

  logger.info("startup.ready", { appVersion: app.getVersion(), schemaVersion: store.schemaVersion });
  const deviceStore = new DeviceStore(store.db);
  terminal = new TerminalService({
    store: deviceStore,
    pins: new PinStore(store.db),
    // No cookie jar: the server must see a Bearer client, never a browser session.
    api: new ApiSession(currentApiBaseUrl, (url, init) => net.fetch(url, { ...init, credentials: "omit" })),
    serverUrl: currentApiBaseUrl,
    serverUrlEditable: true,
    readWindowsSession: () => classifyWindowsSession(readWindowsSession()),
    appVersion: app.getVersion(),
    logger,
  });
  registerIpc(store.schemaVersion, logger);
  mainWindow = createMainWindow({ devServerUrl, show: true });
  mainWindow.on("closed", () => (mainWindow = null));
}

// Two processes on one SQLite file is how a till ends up with two sales under one receipt number.
if (!smokeMode && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.enableSandbox();
  registerAppScheme();
  hardenWebContents(devServerOrigin);

  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("will-quit", () => store?.db.close());

  void app.whenReady().then(start);
}
