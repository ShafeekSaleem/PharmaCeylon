import { app, BrowserWindow, dialog, Menu, net, safeStorage, session } from "electron";
import { createPublicKey } from "node:crypto";
import { join } from "node:path";
import type { ActionResult } from "../shared/ipc-contract";
import { ApiSession } from "./api/api-client";
import { checkApi } from "./api-check";
import { classifyWindowsSession, createWindowsSessionReader } from "./attendance/windows-session";
import type { SecretProtector } from "./db/key-store";
import { migrations } from "./db/migrations";
import { registerIpcHandlers } from "./ipc/handle";
import type { LocalStore } from "./local-store";
import { openStoreAtStartup, type RestorePrompt } from "./backup/startup-restore";
import { startStoreBackups, type StoreBackup } from "./backup/store-backup";
import { createLogger } from "./logging/logger";
import { printTestReceipt } from "./printing/test-receipt";
import { printHtml } from "./printing/print-html";
import { renderSaleReceiptHtml } from "./printing/receipt-html";
import { renderXReportHtml } from "./printing/x-report-html";
import { CheckoutService } from "./checkout/checkout-service";
import { DispensingService } from "./checkout/dispensing";
import { CounterWorkService } from "./terminal/counter-work";
import { ReturnsService } from "./returns/returns-service";
import { journalSyncForRenderer } from "./journal-sync-renderer";
import { readInstalledOfflineAuthority } from "./terminal/offline-authority";
import { startOfflineAuthorityRefresh, type OfflineAuthorityRefresh } from "./terminal/offline-authority-refresh";
import { OfflineJournalWriter } from "./terminal/offline-journal-writer";
import {
  readJournalSyncView,
  startOfflineJournalSync,
  type OfflineJournalSync,
} from "./terminal/offline-journal-sync";
import { SignedCommandService } from "./terminal/signed-commands";
import { ShiftService } from "./shifts/shift-service";
import { OfflineSupportService } from "./terminal/offline-support-service";
import { StockLookupService } from "./terminal/stock-lookup";
import type { CompletedSale } from "../shared/ipc-contract";
import { buildReadinessReport, type ReadinessFacts } from "./readiness";
import { isAppUrl } from "./renderer-path";
import { hardenSession, hardenWebContents, mainFetch, registerAppScheme, serveRenderer } from "./security";
import { normalizeServerUrl, readServerUrl, writeServerUrl } from "./server-url";
import { runSmokeTest } from "./smoke";
import { DeviceStore } from "./device/device-store";
import { PinStore } from "./staff/pin-store";
import { listProcessImages } from "./attendance/remote-tools";
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
// The environment address gets the same checks as one typed at setup: HTTPS when packaged.
const defaultApiBaseUrl = configuredServerUrl(process.env.POS_API_BASE_URL);

function configuredServerUrl(raw: string | undefined): string | null {
  if (!raw) return app.isPackaged ? null : "http://127.0.0.1:3001/api/v1";
  try {
    return normalizeServerUrl(raw, app.isPackaged);
  } catch {
    // Refused: setup asks for the address instead of trusting an unsafe one.
    return null;
  }
}
const readWindowsSession = createWindowsSessionReader();

// DPAPI, via Electron: the blob can only be opened by this Windows user on this machine.
const protector: SecretProtector = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  protect: (plain) => safeStorage.encryptString(plain),
  unprotect: (blob) => safeStorage.decryptString(blob),
};

/** P5 #51: offered only where a restore is allowed (a broken or empty store); native dialogs, no window yet. */
const backupLabel = ({ manifest }: StoreBackup) => {
  const at = new Date(manifest.takenAt);
  const counter = [manifest.counterLabel, manifest.branchName].filter(Boolean).join(", ");
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${at.toLocaleDateString()} ${time}${counter ? ` (${counter})` : ""}`;
};
function chooseBackup(message: string, detail: string, backups: readonly StoreBackup[], cancel: string): StoreBackup | null {
  const offered = backups.slice(0, 6);
  const answer = dialog.showMessageBoxSync({
    type: "warning",
    title: "PharmaCeylon POS",
    message,
    detail,
    buttons: [...offered.map((b, i) => `${i === 0 ? "Restore the newest backup" : "Restore the backup"} from ${backupLabel(b)}`), cancel],
    defaultId: 0,
    cancelId: offered.length,
    noLink: true,
  });
  return offered[answer] ?? null;
}
const restoreDetail = [
  "Anything recorded on this computer after the backup was taken is not in it.",
  "After a restore, staff sign in online again, and offline selling stays off until the owner or a delegated manager acknowledges the restore in the back office.",
].join(" ");
const restorePrompt: RestorePrompt = {
  afterFailure: (error, backups) =>
    chooseBackup(
      "The local database could not be opened.",
      [error instanceof Error ? error.message : "", "This computer has backups of its store.", restoreDetail].filter(Boolean).join("\n\n"),
      backups,
      "Quit and contact support",
    ),
  forEmptyStore: (backups) =>
    chooseBackup("This computer has no counter set up, but it has backups of one.", restoreDetail, backups, "Set up as a new counter"),
};

let mainWindow: BrowserWindow | null = null;
let store: LocalStore | null = null;
let terminal: TerminalService | null = null;
let checkout: CheckoutService | null = null;
let dispensing: DispensingService | null = null;
let commands: SignedCommandService | null = null;
let counterWork: CounterWorkService | null = null;
let shifts: ShiftService | null = null;
let stock: StockLookupService | null = null;
let offlineSupport: OfflineSupportService | null = null;
let returns: ReturnsService | null = null;
let authorityRefresh: OfflineAuthorityRefresh | null = null;
let journalSync: OfflineJournalSync | null = null;
// Receipts can be reprinted for sales completed since the app started; nothing is kept on disk.
const recentSales = new Map<string, CompletedSale>();

function currentApiBaseUrl(): string | null {
  if (!store) return defaultApiBaseUrl;
  return new DeviceStore(store.db).read()?.apiBaseUrl ?? readServerUrl(store.db) ?? defaultApiBaseUrl;
}

/** Runs a renderer-requested action; refusals come back as explained data, details go to the log. */
/**
 * Unconfirmed sales and signed actions. A sale names who started it (anyone here can confirm it);
 * an action names who has to come back to confirm it.
 */
function unconfirmedFacts(): { unconfirmed: number; unconfirmedSalesBy: string[]; unconfirmedBy: string[] } {
  const sales = checkout?.pending() ?? [];
  const actions = commands?.pending() ?? [];
  const names = (rows: { staffName: string | null }[]) => [
    ...new Set(rows.map((p) => p.staffName ?? "someone who has signed out")),
  ];
  return {
    unconfirmed: sales.length + actions.length,
    unconfirmedSalesBy: names(sales),
    unconfirmedBy: names(actions),
  };
}

function requireShifts(): ShiftService {
  if (!shifts) throw new ActionFailure("NOT_READY", "The counter is still starting.");
  return shifts;
}

function requireOfflineSupport(): OfflineSupportService {
  if (!offlineSupport) throw new ActionFailure("NOT_READY", "The counter is still starting.");
  return offlineSupport;
}

/** A completed counter sale moves the open shift's own running expected cash (D7b), once. */
function postSale(sale: CompletedSale): void {
  const seller = terminal?.current()?.staff.staffUserId;
  if (seller) shifts?.recordSale(sale, seller);
}

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

/** The offline journal's upload (P5 #51), for the readiness checks and the Sell page. */
function journalSyncFacts(): Pick<ReadinessFacts, "journalSync"> {
  const enrollmentId = store ? new DeviceStore(store.db).read()?.identity.enrollmentId : undefined;
  if (!store || !enrollmentId) return {};
  return {
    journalSync: {
      configured: journalSync !== null,
      view: journalSync ? journalSync.view(enrollmentId) : readJournalSyncView(store.db, enrollmentId),
    },
  };
}

/** The installed offline authority and how its renewal is going, for the readiness checks. */
function offlineAuthorityFacts(): Pick<ReadinessFacts, "offlineAuthority"> {
  const enrollmentId = store ? new DeviceStore(store.db).read()?.identity.enrollmentId : undefined;
  if (!store || !enrollmentId) return {};
  const installed = readInstalledOfflineAuthority(store.db, enrollmentId);
  return {
    offlineAuthority: {
      refresh: authorityRefresh?.status() ?? null,
      installed: installed && {
        grantExpiresAt: installed.grant.payload.expiresAt,
        snapshotGeneratedAt: installed.snapshot.payload.generatedAt,
        authorizedStaff: installed.grant.payload.authorizedStaff.length,
        lines: installed.snapshot.payload.lines.length,
      },
    },
  };
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
            preparedStaff: store
              ? (
                  store.db
                    .prepare("SELECT count(*) AS n FROM staff_credential WHERE enrollment_id = ?")
                    .get(new DeviceStore(store.db).read()?.identity.enrollmentId ?? "") as { n: number }
                ).n
              : 0,
            ...unconfirmedFacts(),
            ...offlineAuthorityFacts(),
            ...journalSyncFacts(),
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
          counterStaff: [],
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
      listCounters: ({ branchId, includeInactive }) =>
        act(logger, "listCounters", (service) => service.listCounters(branchId, includeInactive)),
      updateCounter: ({ branchId, registerId, label, isActive }) =>
        act(logger, "updateCounter", (service) =>
          service.updateCounter(branchId, registerId, { label, isActive }),
        ),
      deleteCounter: ({ branchId, registerId }) =>
        act(logger, "deleteCounter", async (service) => {
          await service.deleteCounter(branchId, registerId);
          return {};
        }),
      createCounter: ({ branchId, label }) =>
        act(logger, "createCounter", (service) => service.createCounter(branchId, label)),
      enroll: (input) => act(logger, "enroll", (service) => service.enroll(input)),
      enrollWithCode: (input) => act(logger, "enrollWithCode", (service) => service.enrollWithCode(input)),
      catalog: () =>
        act(logger, "catalog", () => {
          if (!checkout) throw new ActionFailure("NOT_READY", "The counter is still starting.");
          return checkout.catalog();
        }),
      submitCheckout: ({ lines, tender, dispensing: details, coSign, discountCoSign }) =>
        act(logger, "submitCheckout", async () => {
          if (!checkout) throw new ActionFailure("NOT_READY", "The counter is still starting.");
          const sale = await checkout.submit(lines, tender, details, coSign, discountCoSign);
          recentSales.set(sale.saleId, sale);
          postSale(sale);
          return sale;
        }),
      holdCart: ({ lines, label, dispensing: details }) =>
        act(logger, "holdCart", () => {
          if (!checkout) throw new ActionFailure("NOT_READY", "The counter is still starting.");
          return checkout.hold(lines, label, details);
        }),
      listHolds: () =>
        act(logger, "listHolds", () => {
          if (!checkout) throw new ActionFailure("NOT_READY", "The counter is still starting.");
          return checkout.holds();
        }),
      recallHold: ({ holdId }) =>
        act(logger, "recallHold", async () => {
          if (!checkout || !dispensing) throw new ActionFailure("NOT_READY", "The counter is still starting.");
          const held = await checkout.recall(holdId);
          // The hold keeps ids only; one that no longer resolves comes back unlinked.
          const [customer, prescription] = await Promise.all([
            held.customerId ? dispensing.customer(held.customerId).catch(() => null) : null,
            held.prescriptionId ? dispensing.prescription(held.prescriptionId).catch(() => null) : null,
          ]);
          return { lines: held.lines, customer, prescription };
        }),
      listDiscountApprovers: () =>
        act(logger, "listDiscountApprovers", () => {
          if (!checkout) throw new ActionFailure("NOT_READY", "The counter is still starting.");
          return checkout.discountApprovers();
        }),
      pendingCheckouts: () => checkout?.pending() ?? [],
      retryCheckout: ({ draftId, coSign, discountCoSign }) =>
        act(logger, "retryCheckout", async () => {
          if (!checkout) throw new ActionFailure("NOT_READY", "The counter is still starting.");
          const sale = await checkout.retry(draftId, coSign, discountCoSign);
          recentSales.set(sale.saleId, sale);
          postSale(sale);
          return sale;
        }),
      searchCustomers: ({ q }) =>
        act(logger, "searchCustomers", () => {
          if (!dispensing) throw new ActionFailure("NOT_READY", "The counter is still starting.");
          return dispensing.customers(q);
        }),
      searchPrescriptions: (filter) =>
        act(logger, "searchPrescriptions", () => {
          if (!dispensing) throw new ActionFailure("NOT_READY", "The counter is still starting.");
          return dispensing.prescriptions(filter);
        }),
      recordPrescription: (input) =>
        act(logger, "recordPrescription", () => {
          if (!dispensing) throw new ActionFailure("NOT_READY", "The counter is still starting.");
          return dispensing.record(input);
        }),
      listApprovers: () =>
        act(logger, "listApprovers", () => {
          if (!dispensing) throw new ActionFailure("NOT_READY", "The counter is still starting.");
          return dispensing.approvers();
        }),
      printSaleReceipt: ({ saleId, printerName }) => {
        const sale = recentSales.get(saleId);
        const device = store ? new DeviceStore(store.db).read() : null;
        if (!sale || !device) return { ok: false, error: "That sale is not available to print here." };
        return printHtml(printerName, renderSaleReceiptHtml(sale, { branchName: device.branchName, counterLabel: device.counterLabel }));
      },
      counterWork: () =>
        act(logger, "counterWork", () => {
          if (!counterWork) throw new ActionFailure("NOT_READY", "The counter is still starting.");
          return counterWork.list();
        }),
      refundsReady: () =>
        act(logger, "refundsReady", () => {
          if (!counterWork) throw new ActionFailure("NOT_READY", "The counter is still starting.");
          return counterWork.refundsReady();
        }),
      executeRefund: ({ refundRequestId }) =>
        act(logger, "executeRefund", async () => {
          if (!counterWork) throw new ActionFailure("NOT_READY", "The counter is still starting.");
          const executed = await counterWork.executeRefund(refundRequestId);
          const executor = terminal?.current()?.staff.staffUserId;
          if (!executed.alreadyApplied && executor) shifts?.recordRefund(executed.requestNumber, executed.refundedTo, executor);
          return executed;
        }),
      stockCasesReady: () =>
        act(logger, "stockCasesReady", () => {
          if (!counterWork) throw new ActionFailure("NOT_READY", "The counter is still starting.");
          return counterWork.stockCasesReady();
        }),
      resolveStockCase: ({ resolutionId, counts }) =>
        act(logger, "resolveStockCase", () => {
          if (!counterWork) throw new ActionFailure("NOT_READY", "The counter is still starting.");
          return counterWork.resolveStockCase(resolutionId, counts);
        }),
      returnFindSale: ({ invoiceNo }) =>
        act(logger, "returnFindSale", () => {
          if (!returns) throw new ActionFailure("NOT_READY", "The counter is still starting.");
          return returns.findSale(invoiceNo);
        }),
      returnSearchSales: (filter) =>
        act(logger, "returnSearchSales", () => {
          if (!returns) throw new ActionFailure("NOT_READY", "The counter is still starting.");
          return returns.searchSales(filter);
        }),
      returnsToday: () =>
        act(logger, "returnsToday", () => {
          if (!returns) throw new ActionFailure("NOT_READY", "The counter is still starting.");
          return returns.today();
        }),
      listRefundApprovers: () =>
        act(logger, "listRefundApprovers", () => {
          if (!returns) throw new ActionFailure("NOT_READY", "The counter is still starting.");
          return returns.approvers();
        }),
      approveReturn: ({ saleId, refundRequestId, coSign }) =>
        act(logger, "approveReturn", () => {
          if (!returns) throw new ActionFailure("NOT_READY", "The counter is still starting.");
          return returns.approve(saleId, refundRequestId, coSign);
        }),
      submitReturn: (input) =>
        act(logger, "submitReturn", async () => {
          if (!returns) throw new ActionFailure("NOT_READY", "The counter is still starting.");
          const outcome = await returns.submit(input);
          // A cash refund done here leaves the open shift's drawer: the counter's own figure too.
          const executor = terminal?.current()?.staff.staffUserId;
          if (outcome.status === "refunded" && !outcome.refund.alreadyApplied && executor)
            shifts?.recordRefund(outcome.refund.requestNumber, outcome.refund.refundedTo, executor);
          return outcome;
        }),
      pendingCommands: () => commands?.pending() ?? [],
      retryCommand: ({ commandId }) =>
        act(logger, "retryCommand", async () => {
          if (!commands) throw new ActionFailure("NOT_READY", "The counter is still starting.");
          return { replayed: (await commands.retry(commandId)).replayed };
        }),
      stockSearch: (input) =>
        act(logger, "stockSearch", () => {
          if (!stock) throw new ActionFailure("NOT_READY", "The counter is still starting.");
          return stock.search(input);
        }),
      stockAttention: () =>
        act(logger, "stockAttention", () => {
          if (!stock) throw new ActionFailure("NOT_READY", "The counter is still starting.");
          return stock.attention();
        }),
      productStock: ({ productId }) =>
        act(logger, "productStock", () => {
          if (!stock) throw new ActionFailure("NOT_READY", "The counter is still starting.");
          return stock.product(productId);
        }),
      adjustStock: (input) =>
        act(logger, "adjustStock", () => {
          if (!stock) throw new ActionFailure("NOT_READY", "The counter is still starting.");
          return stock.adjust(input);
        }),
      quarantineBatch: (input) =>
        act(logger, "quarantineBatch", () => {
          if (!stock) throw new ActionFailure("NOT_READY", "The counter is still starting.");
          return stock.quarantine(input);
        }),
      releaseQuarantine: (input) =>
        act(logger, "releaseQuarantine", () => {
          if (!stock) throw new ActionFailure("NOT_READY", "The counter is still starting.");
          return stock.releaseQuarantine(input);
        }),
      stockPermissions: () =>
        act(logger, "stockPermissions", () => {
          if (!stock) throw new ActionFailure("NOT_READY", "The counter is still starting.");
          return stock.permissions();
        }),
      heldWriteOffsAtCounter: () =>
        act(logger, "heldWriteOffsAtCounter", () => {
          if (!counterWork) throw new ActionFailure("NOT_READY", "The counter is still starting.");
          return counterWork.heldWriteOffsAtCounter();
        }),
      postHeldWriteOff: ({ heldAdjustmentId, approvalEvidenceId }) =>
        act(logger, "postHeldWriteOff", () => {
          if (!counterWork) throw new ActionFailure("NOT_READY", "The counter is still starting.");
          return counterWork.postHeldWriteOff(heldAdjustmentId, approvalEvidenceId);
        }),
      confirmTestReceipt: ({ printerName }) =>
        act(logger, "confirmTestReceipt", (service) => service.confirmTestReceipt(printerName)),
      offlineCounter: () => act(logger, "offlineCounter", (service) => service.offlineCounter()),
      activateOffline: ({ authorizationId }) =>
        act(logger, "activateOffline", (service) => service.activateOffline(authorizationId)),
      setPin: ({ pin, password }) => act(logger, "setPin", (service) => service.setPin(pin, password)),
      preparePin: ({ pin }) => act(logger, "preparePin", (service) => service.preparePin(pin)),
      lock: () => act(logger, "lock", (service) => service.lock()),
      unlock: ({ pin }) => act(logger, "unlock", (service) => service.unlock(pin)),
      getShift: () => shifts?.state() ?? { current: null, lastClosed: null, unsynced: [] },
      getJournalSync: () => {
        const enrollmentId = store
          ? new DeviceStore(store.db).read()?.identity.enrollmentId
          : undefined;
        return journalSyncForRenderer(
          journalSyncFacts().journalSync?.view ?? null,
          store?.db ?? null,
          enrollmentId,
          authorityRefresh?.status() ?? null,
        );
      },
      offlineSales: () => act(logger, "offlineSales", () => requireOfflineSupport().sales()),
      noteSaleProblem: (input) => act(logger, "noteSaleProblem", () => requireOfflineSupport().recordIncident(input)),
      cardAttempts: () => act(logger, "cardAttempts", () => requireOfflineSupport().cardAttempts()),
      prepareCardAttempt: (input) => act(logger, "prepareCardAttempt", () => requireOfflineSupport().prepareCard(input)),
      recordCardOutcome: (input) => act(logger, "recordCardOutcome", () => requireOfflineSupport().recordCardOutcome(input)),
      refreshShift: () => act(logger, "refreshShift", () => requireShifts().refresh()),
      openShift: ({ pin, count }) => act(logger, "openShift", () => requireShifts().open(pin, count)),
      closeShift: ({ count, varianceNote, assistance }) =>
        act(logger, "closeShift", () => requireShifts().close(count, { varianceNote, assistance })),
      retryShiftClose: ({ pin }) => act(logger, "retryShiftClose", () => requireShifts().retryClose(pin)),
      listShifts: () => act(logger, "listShifts", () => requireShifts().list()),
      shiftDetail: ({ workSessionId }) => act(logger, "shiftDetail", () => requireShifts().detail(workSessionId)),
      printXReport: ({ printerName }) =>
        act(logger, "printXReport", async (service) => {
          const report = await requireShifts().xReport();
          const device = store ? new DeviceStore(store.db).read() : null;
          const printedBy = service.current()?.staff.staffName ?? "";
          return printHtml(
            printerName,
            renderXReportHtml({
              branchName: device?.branchName ?? "",
              counterLabel: device?.counterLabel ?? "",
              shiftNumber: report.shift.shiftNumber,
              staffName: report.shift.staffName,
              openedAt: report.shift.openedAt,
              printedAt: new Date(),
              printedBy,
              summary: report.summary,
              current: report.current,
            }),
          );
        }),
      pinSignIn: ({ staffUserId, pin }) =>
        act(logger, "pinSignIn", (service) => service.signInWithPin(staffUserId, pin)),
    },
    { isTrustedSender: (url) => isAppUrl(url, devServerOrigin), logger },
  );
}

function showStartupError(error: unknown): void {
  dialog.showErrorBox(
    "PharmaCeylon POS cannot start",
    `${error instanceof Error ? error.message : "The local database could not be opened."}\n\n` +
      "Do not delete or move any files. Contact support.",
  );
}

/**
 * Anything `start` throws ends in an error box and an exit. Left alone, the process would keep the
 * single-instance lock with no window, so that starting the app again does nothing (P5 #51).
 */
function failStartup(error: unknown): void {
  console.error("startup.failed", error);
  try {
    showStartupError(error);
  } finally {
    app.exit(1);
  }
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

  // P5 #51: backups of the store stay on this computer, beside its data (decisions of 2026-11-10).
  const backupsDir = join(app.getPath("userData"), "backups");
  const opened = openStoreAtStartup({
    dataDir,
    backupsDir,
    protector,
    migrations,
    appVersion: app.getVersion(),
    prompt: restorePrompt,
    report: (event, detail) => logger.warn(event, detail),
  });
  if (opened.kind === "restored") {
    // Start again on the restored store, from the top: nothing here has seen it yet.
    await logger.flush();
    app.relaunch();
    app.exit(0);
    return;
  }
  if (opened.kind === "failed") {
    const error = opened.error;
    // Unsafe to continue: no window is created, so nothing can be sold
    // against a database that is missing, unreadable or half-upgraded.
    logger.error("startup.local_store_failed", { error });
    await logger.flush();
    showStartupError(error);
    app.exit(1);
    return;
  }
  store = opened.store;
  const backups = startStoreBackups({
    db: store.db,
    keyPath: store.keyPath,
    backupsDir,
    protector,
    appVersion: app.getVersion(),
    report: (error) => logger.warn("store_backup.failed", { error }),
  });
  app.once("before-quit", () => backups.stop());

  logger.info("startup.ready", { appVersion: app.getVersion(), schemaVersion: store.schemaVersion });
  const deviceStore = new DeviceStore(store.db);
  const offlineJournalWriter = new OfflineJournalWriter({ db: store.db });
  // Offline PIN lockouts count down in uptime; save their progress so a restart resumes it.
  const pins = new PinStore(store.db);
  pins.checkpoint();
  setInterval(() => pins.checkpoint(), 60_000).unref();
  app.on("before-quit", () => pins.checkpoint());
  // No cookie jar: the server must see a Bearer client, never a browser session.
  const terminalApi = new ApiSession(currentApiBaseUrl, (url, init) => net.fetch(url, { ...init, credentials: "omit" }));
  terminal = new TerminalService({
    store: deviceStore,
    pins,
    api: terminalApi,
    serverUrl: currentApiBaseUrl,
    serverUrlEditable: true,
    readWindowsSession: () => classifyWindowsSession(readWindowsSession()),
    listProcesses: listProcessImages,
    appVersion: app.getVersion(),
    logger,
    offlineJournal: offlineJournalWriter,
  });
  const authorityKeyId = process.env.POS_OFFLINE_AUTHORITY_KEY_ID;
  const authorityPublicKey = process.env.POS_OFFLINE_AUTHORITY_PUBLIC_KEY;
  if (authorityKeyId && authorityPublicKey) {
    try {
      const publicKey = createPublicKey(authorityPublicKey);
      if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("Expected Ed25519 public key");
      const { refresh, stop: stopRefresh } = startOfflineAuthorityRefresh({
        db: store.db,
        api: terminalApi,
        terminal,
        readDevice: () => deviceStore.read(),
        signer: { keyId: authorityKeyId, publicKey },
        report: (error) => logger.warn("offline_authority.refresh_failed", { error }),
      });
      authorityRefresh = refresh;
      app.once("before-quit", stopRefresh);
      // P5 #51: the journal upload and reconnect drain, verified with the same server key.
      const { sync, stop: stopSync } = startOfflineJournalSync({
        db: store.db,
        api: terminalApi,
        terminal,
        signer: { keyId: authorityKeyId, publicKey },
        refresh,
        report: (error) => logger.warn("offline_journal.sync_failed", { error }),
      });
      journalSync = sync;
      app.once("before-quit", stopSync);
    } catch (error) {
      logger.error("offline_authority.invalid_public_key", { error });
    }
  }
  checkout = new CheckoutService({ db: store.db, api: terminalApi, terminal, logger, offlineJournal: offlineJournalWriter });
  commands = new SignedCommandService({ db: store.db, api: terminalApi, terminal, logger });
  dispensing = new DispensingService({ api: terminalApi, terminal, commands });
  counterWork = new CounterWorkService({ api: terminalApi, terminal, commands });
  shifts = new ShiftService({ db: store.db, api: terminalApi, terminal, device: deviceStore, logger });
  offlineSupport = new OfflineSupportService({ db: store.db, terminal, journal: offlineJournalWriter });
  stock = new StockLookupService({ api: terminalApi, terminal, commands });
  returns = new ReturnsService({ api: terminalApi, terminal, commands });
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

  void app.whenReady().then(start).catch(failStartup);
}
