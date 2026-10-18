import { app, BrowserWindow, dialog, Menu, safeStorage, session } from "electron";
import { join } from "node:path";
import { checkApi } from "./api-check";
import type { SecretProtector } from "./db/key-store";
import { migrations } from "./db/migrations";
import { registerIpcHandlers } from "./ipc/handle";
import { openLocalStore, type LocalStore } from "./local-store";
import { createLogger } from "./logging/logger";
import { printTestReceipt } from "./printing/test-receipt";
import { buildReadinessReport } from "./readiness";
import { isAppUrl } from "./renderer-path";
import { hardenSession, hardenWebContents, mainFetch, registerAppScheme, serveRenderer } from "./security";
import { runSmokeTest } from "./smoke";
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

// Until device activation supplies it, the API address comes from the
// environment (and defaults to the local Nest port in development).
const apiBaseUrl = process.env.POS_API_BASE_URL ?? (app.isPackaged ? null : "http://127.0.0.1:3001/api/v1");

// DPAPI, via Electron: the blob can only be opened by this Windows user on this machine.
const protector: SecretProtector = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  protect: (plain) => safeStorage.encryptString(plain),
  unprotect: (blob) => safeStorage.decryptString(blob),
};

let mainWindow: BrowserWindow | null = null;
let store: LocalStore | null = null;

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
          },
          new Date(),
        ),
      checkApi: () => checkApi(apiBaseUrl, mainFetch),
      listPrinters: async () => {
        const printers = (await mainWindow?.webContents.getPrintersAsync()) ?? [];
        return printers.map((printer) => ({
          name: printer.name,
          displayName: printer.displayName || printer.name,
        }));
      },
      printTestReceipt: ({ printerName }) => printTestReceipt(printerName, app.getVersion()),
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
