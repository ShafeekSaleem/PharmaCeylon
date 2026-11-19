import { join, resolve, sep } from "node:path";
import { ipcContract } from "../shared/ipc-contract";
import { checkApi } from "./api-check";
import { renderTestReceiptHtml } from "./printing/receipt-html";
import {
  buildReadinessReport,
  clockTime,
  DISK_FAILED_BYTES,
  DISK_WARNING_BYTES,
  explainRefreshFailure,
  isVirtualPrinter,
  offlineManagerNames,
} from "./readiness";
import { isAppUrl, resolveRendererFile } from "./renderer-path";
import type { CheckoutSyncPause } from "./terminal/reconnect-drain";

describe("resolveRendererFile", () => {
  const root = resolve("/app/dist/renderer");

  it("serves files inside the renderer directory", () => {
    expect(resolveRendererFile(root, "pos://app/")).toBe(join(root, "index.html"));
    expect(resolveRendererFile(root, "pos://app/assets/index.js")).toBe(join(root, "assets", "index.js"));
  });

  it.each([
    "pos://app/../main/index.js",
    "pos://app/..%2F..%2Fpackage.json",
    "pos://app/%2e%2e/%2e%2e/secret",
    "pos://app/assets/..%5C..%5C..%5Cmain%5Cindex.js",
    "pos://other/index.html",
    "file:///C:/Windows/win.ini",
    "pos://app/%E0%A4%A",
    "not a url",
  ])("never leaves the renderer directory for %s", (url) => {
    // Either rejected outright, or normalised by the URL parser to a path still inside the root.
    const file = resolveRendererFile(root, url);
    expect(file === null || file.startsWith(root + sep)).toBe(true);
  });
});

describe("isAppUrl", () => {
  it("trusts only the app origin in production", () => {
    expect(isAppUrl("pos://app/index.html", null)).toBe(true);
    expect(isAppUrl("pos://evil/index.html", null)).toBe(false);
    expect(isAppUrl("https://example.com/", null)).toBe(false);
    expect(isAppUrl("http://localhost:5173/", null)).toBe(false);
    expect(isAppUrl("file:///C:/x.html", null)).toBe(false);
  });

  it("additionally trusts exactly the dev server origin in development", () => {
    expect(isAppUrl("http://localhost:5173/src/main.tsx", "http://localhost:5173")).toBe(true);
    expect(isAppUrl("http://localhost:5174/", "http://localhost:5173")).toBe(false);
  });
});

describe("buildReadinessReport", () => {
  const healthy = { databaseOpen: true, schemaVersion: 1, latestSchemaVersion: 1, credentialStoreAvailable: true };
  const statusOf = (report: ReturnType<typeof buildReadinessReport>, id: string) =>
    report.checks.find((check) => check.id === id)?.status;

  it("is not ready while the device is unactivated, however healthy the rest is", () => {
    const report = buildReadinessReport(healthy, new Date("2026-10-11T00:00:00Z"));
    expect(report.ready).toBe(false);
    expect(statusOf(report, "database")).toBe("ok");
    expect(statusOf(report, "device")).toBe("not_ready");
  });

  it("reports the device check from the enrollment status", () => {
    expect(statusOf(buildReadinessReport({ ...healthy, enrollmentStatus: "active" }, new Date()), "device")).toBe("ok");
    expect(statusOf(buildReadinessReport({ ...healthy, enrollmentStatus: "pending" }, new Date()), "device")).toBe(
      "warning",
    );
    expect(statusOf(buildReadinessReport({ ...healthy, enrollmentStatus: "revoked" }, new Date()), "device")).toBe(
      "failed",
    );
    // An enrolled device is still not ready for an outage until the grant and the rest exist.
    expect(buildReadinessReport({ ...healthy, enrollmentStatus: "active" }, new Date()).ready).toBe(false);
  });

  it("reports prepared staff and unconfirmed work", () => {
    const report = buildReadinessReport({ ...healthy, preparedStaff: 2, unconfirmed: 1 }, new Date());
    expect(statusOf(report, "staff")).toBe("ok");
    expect(statusOf(report, "unconfirmed")).toBe("warning");
    expect(statusOf(buildReadinessReport(healthy, new Date()), "staff")).toBe("not_ready");
  });

  it("says who started an unconfirmed sale and that anyone here can confirm it", () => {
    const report = buildReadinessReport(
      { ...healthy, unconfirmed: 2, unconfirmedSalesBy: ["Nimal Perera"], unconfirmedBy: ["Kamala Silva"] },
      new Date(),
    );
    const detail = report.checks.find((check) => check.id === "unconfirmed")!.detail;
    expect(detail).toContain("Sales started by Nimal Perera: anyone signed in here can confirm them.");
    expect(detail).toContain("Only the person who sent each action can confirm it: Kamala Silva.");
  });

  it("fails the database and schema checks when the store is not usable", () => {
    const report = buildReadinessReport({ ...healthy, databaseOpen: false }, new Date());
    expect(statusOf(report, "database")).toBe("failed");
    expect(statusOf(report, "schema")).toBe("failed");
  });

  it("covers every FR-004 area", () => {
    const ids = buildReadinessReport(healthy, new Date()).checks.map((check) => check.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "database", "grant", "device", "catalogue", "receipt-numbers", "printer", "sync", "clock", "card-money", "support-records",
      ]),
    );
  });
});

describe("checkApi", () => {
  const init = expect.objectContaining({ signal: expect.anything() });

  it("reports reachable only for a healthy response", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    const result = await checkApi("http://api.test/api/v1/", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith("http://api.test/api/v1/health", init);
    expect(result.reachable).toBe(true);
    expect(result.latencyMs).not.toBeNull();
  });

  it.each([
    ["a 5xx", jest.fn().mockResolvedValue({ ok: false, json: async () => ({}) })],
    ["an unexpected body", jest.fn().mockResolvedValue({ ok: true, json: async () => ({ hello: "captive portal" }) })],
    ["a network failure", jest.fn().mockRejectedValue(new Error("ENOTFOUND"))],
  ])("reports unreachable on %s", async (_label, fetchImpl) => {
    expect(await checkApi("http://api.test", fetchImpl)).toMatchObject({ reachable: false, latencyMs: null });
  });

  it("does not call out at all when no API address is configured", async () => {
    const fetchImpl = jest.fn();
    expect((await checkApi(null, fetchImpl)).reachable).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("renderTestReceiptHtml", () => {
  it("escapes the printer name", () => {
    const html = renderTestReceiptHtml({
      printerName: `<script>alert("x")</script>`,
      printedAt: new Date("2026-10-11T10:00:00Z"),
      appVersion: "0.0.1",
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("NOT A SALE");
  });
});

describe("ipcContract", () => {
  it("uses unique, namespaced channels", () => {
    const channels = Object.values(ipcContract).map((entry) => entry.channel);
    expect(new Set(channels).size).toBe(channels.length);
    for (const channel of channels) expect(channel).toMatch(/^pos:[a-z-]+(:[a-z-]+)+$/);
  });

  it("rejects malformed input", () => {
    const { input } = ipcContract.printTestReceipt;
    expect(input.safeParse({ printerName: "EPSON TM-T20" }).success).toBe(true);
    expect(input.safeParse({ printerName: "" }).success).toBe(false);
    expect(input.safeParse({ printerName: 42 }).success).toBe(false);
    expect(input.safeParse(undefined).success).toBe(false);
    expect(ipcContract.getReadiness.input.safeParse({ unexpected: true }).success).toBe(false);
  });
});

describe("offline backup readiness (P3 #49)", () => {
  const now = new Date(2026, 10, 4, 14, 32);
  const t = now.getTime();
  const active = {
    databaseOpen: true, schemaVersion: 1, latestSchemaVersion: 1, credentialStoreAvailable: true,
    enrollmentStatus: "active" as const, preparedStaff: 5,
  };
  const healthyRefresh = { nominated: true, nominatedAt: t - 60_000, lastSuccessAt: t - 60_000, consecutiveFailures: 0, lastFailure: null, nextAttemptAt: null };
  const installed = { grantExpiresAt: t + 86_340_000, snapshotGeneratedAt: t - 120_000, authorizedStaff: 4, lines: 412, receiptNumbering: { prefix: "C1R", nextReceipt: "C1R-000001" }, offlineManagers: { acknowledgeHours: ["Nadeesha"], assistHandover: ["Nadeesha"] } };
  const check = (report: ReturnType<typeof buildReadinessReport>, id: string) => report.checks.find((c) => c.id === id)!;

  it("shows the grant's expiry, the saved stock's time and who can sign in offline", () => {
    const report = buildReadinessReport({ ...active, offlineAuthority: { refresh: healthyRefresh, installed } }, now);
    expect(check(report, "grant")).toMatchObject({ status: "ok", detail: "Valid until 14:31 tomorrow. Renewed automatically while online." });
    expect(check(report, "catalogue")).toMatchObject({ status: "ok", detail: "Stock and prices saved 14:30 today, 412 batches." });
    expect(check(report, "staff").detail).toBe("5 people have a PIN prepared here. 4 can sign in offline under the current permission.");
    expect(report.offlineBackup).toMatchObject({ usable: true, authorizedStaff: 4, failures: 0, failure: null });
  });

  it("fails saved stock past 15 minutes and explains the renewal failure", () => {
    const report = buildReadinessReport({
      ...active,
      offlineAuthority: {
        refresh: { ...healthyRefresh, consecutiveFailures: 3, lastFailure: { at: t - 60_000, code: "BRANCH_HOURS_NOT_CONFIGURED" }, nextAttemptAt: t + 4 * 60_000 },
        installed: { ...installed, snapshotGeneratedAt: t - 20 * 60_000 },
      },
    }, now);
    expect(check(report, "catalogue")).toMatchObject({ status: "failed" });
    expect(check(report, "catalogue").detail).toMatch(/^Saved stock is 20 minutes old, over the 15-minute limit for starting an outage\. Renewal failed: The branch's selling hours are not set\. .* Next try 14:36\.$/);
    expect(check(report, "grant").status).toBe("warning");
    expect(report.offlineBackup).toMatchObject({ usable: false, failures: 3 });
    expect(report.ready).toBe(false);
  });

  it("fails an expired grant, and tells a replaced counter it won't be renewed", () => {
    const expired = buildReadinessReport({ ...active, offlineAuthority: { refresh: healthyRefresh, installed: { ...installed, grantExpiresAt: t - 1 } } }, now);
    expect(check(expired, "grant")).toMatchObject({ status: "failed", detail: "Expired 14:31 today. Sign in here while online to renew it." });
    const replaced = buildReadinessReport({ ...active, offlineAuthority: { refresh: { ...healthyRefresh, nominated: false }, installed } }, now);
    expect(check(replaced, "grant")).toMatchObject({ status: "failed" });
    expect(check(replaced, "grant").detail).toContain("no longer the branch's offline backup");
    expect(replaced.offlineBackup?.usable).toBe(false);
  });

  it("is not set up before the first pair, on a non-backup counter, or without a server key", () => {
    const waiting = buildReadinessReport({ ...active, offlineAuthority: { refresh: healthyRefresh, installed: null } }, now);
    expect(check(waiting, "grant")).toMatchObject({ status: "not_ready", detail: expect.stringContaining("fetched automatically") });
    const other = buildReadinessReport({ ...active, offlineAuthority: { refresh: { ...healthyRefresh, nominated: false }, installed: null } }, now);
    expect(check(other, "grant").detail).toContain("not the branch's offline backup");
    const failing = buildReadinessReport({
      ...active,
      offlineAuthority: { refresh: { ...healthyRefresh, consecutiveFailures: 1, lastFailure: { at: t, code: "GRANT_INVALID" } }, installed: null },
    }, now);
    expect(check(failing, "grant").status).toBe("failed");
    const unkeyed = buildReadinessReport({ ...active, offlineAuthority: { refresh: null, installed: null } }, now);
    expect(check(unkeyed, "grant").detail).toContain("no offline permission key");
  });

  it("words every failure as something to do", () => {
    for (const code of [
      "GRANT_INVALID", "BRANCH_HOURS_NOT_CONFIGURED", "RECONCILIATION_REQUIRED", "local_usage", "journal_mismatch",
      "drain_incomplete", "invalid", "RESTORED_COUNTER_WAIT", "NETWORK", "HTTP_502", "WEIRD",
    ])
      expect(explainRefreshFailure(code).length).toBeGreaterThan(20);
    expect(clockTime(new Date(2026, 10, 6, 9, 5).getTime(), now)).toBe("6 Nov 09:05");
  });
});

describe("synchronisation readiness (P5 #51)", () => {
  const now = new Date(2026, 10, 10, 14, 32);
  const t = now.getTime();
  const active = {
    databaseOpen: true, schemaVersion: 1, latestSchemaVersion: 1, credentialStoreAvailable: true,
    enrollmentStatus: "active" as const,
  };
  const view = {
    recorded: 0, accepted: 0, waiting: 0, refused: 0, syncing: false, lastSuccessAt: null as string | null,
    issue: null as { code: string; message: string; sequence: number | null; at: string } | null,
    outage: null, lastDrain: null as { outageId: string; startedAt: number; drainedAt: string } | null,
    pause: null as CheckoutSyncPause | null,
  };
  const sync = (over: Partial<typeof view>, configured = true) =>
    buildReadinessReport({ ...active, journalSync: { configured, view: { ...view, ...over } } }, now).checks.find((c) => c.id === "sync")!;

  it("is ok only once the server has confirmed everything recorded here", () => {
    expect(sync({})).toMatchObject({ status: "not_ready", detail: expect.stringContaining("Not confirmed") });
    expect(sync({ lastSuccessAt: new Date(t - 60_000).toISOString() })).toMatchObject({
      status: "ok", detail: "Everything recorded here is on the server, confirmed 14:31 today.",
    });
    expect(sync({
      recorded: 4, accepted: 4, lastSuccessAt: new Date(t - 60_000).toISOString(),
      lastDrain: { outageId: "o", startedAt: t - 3_600_000, drainedAt: new Date(t - 60_000).toISOString() },
    }).detail).toContain("Offline sales from the outage at 13:32 today are all on the server.");
    expect(sync({}, false)).toMatchObject({ status: "not_ready", detail: expect.stringContaining("no offline permission key") });
    expect(buildReadinessReport(active, now).checks.find((c) => c.id === "sync")!.status).toBe("not_ready");
  });

  it("warns while a drain pauses new sales, and says what it is waiting for", () => {
    const none = { sales: 0, actions: 0 };
    expect(sync({ recorded: 3, waiting: 3, pause: { reason: "draining", waiting: 3, outageStartedAt: t - 600_000, unconfirmed: none, holds: { cards: 0, records: 0, refused: 0 } } })).toMatchObject({
      status: "warning",
      detail: "Synchronising offline sales: new sales wait until it finishes. 3 offline records waiting to reach the server.",
    });
    expect(sync({ recorded: 3, accepted: 3, pause: { reason: "draining", waiting: 0, outageStartedAt: t - 600_000, unconfirmed: none, holds: { cards: 0, records: 0, refused: 0 } } }).detail)
      .toContain("Waiting for fresh stock from the server.");
    // The drain also waits for what was sent from here without a confirmed outcome: say so.
    expect(sync({
      recorded: 3, accepted: 3,
      pause: { reason: "draining", waiting: 0, outageStartedAt: t - 600_000, unconfirmed: { sales: 1, actions: 2 }, holds: { cards: 0, records: 0, refused: 0 } },
    }).detail).toBe(
      "Synchronising offline sales: new sales wait until it finishes. The offline sales are on the server. It finishes once 1 sale and 2 actions sent from here are confirmed.",
    );
    expect(sync({
      recorded: 3, waiting: 3,
      pause: { reason: "draining", waiting: 3, outageStartedAt: t - 600_000, unconfirmed: { sales: 1, actions: 0 }, holds: { cards: 0, records: 0, refused: 0 } },
    }).detail).toContain("3 offline records waiting to reach the server. It finishes once 1 sale sent from here is confirmed.");
  });

  it("says a card payment or an undelivered note is what holds the drain", () => {
    const pause = (holds: { cards: number; records: number; refused: number }) => ({
      reason: "draining" as const, waiting: 0, outageStartedAt: t - 600_000,
      unconfirmed: { sales: 0, actions: 0 }, holds,
    });
    const card = sync({ recorded: 3, accepted: 3, pause: pause({ cards: 1, records: 0, refused: 0 }) }).detail;
    expect(card).toContain("The offline sales are on the server.");
    expect(card).toContain("A card payment from the outage is not settled yet. Open This counter");
    expect(card).not.toContain("Waiting for fresh stock");
    expect(sync({ recorded: 3, accepted: 3, pause: pause({ cards: 0, records: 2, refused: 0 }) }).detail)
      .toContain("2 notes or card records are still on their way to the server.");
    expect(sync({ recorded: 3, accepted: 3, pause: pause({ cards: 0, records: 1, refused: 1 }) }).detail)
      .toContain("It will not clear by itself: contact support.");
  });

  it("fails on a refused record or a journal the server doesn't recognise", () => {
    const refused = sync({
      recorded: 5, accepted: 3, waiting: 2, refused: 1,
      issue: { code: "LOCAL_STOCK_EXHAUSTED", message: "A manager reviews it in the back office.", sequence: 4, at: "" },
      pause: { reason: "draining", waiting: 2, outageStartedAt: t, unconfirmed: { sales: 0, actions: 0 }, holds: { cards: 0, records: 0, refused: 0 } },
    });
    expect(refused).toMatchObject({ status: "failed", detail: "A manager reviews it in the back office. 2 offline records waiting to reach the server." });
    expect(sync({ issue: { code: "JOURNAL_MISMATCH", message: "Contact support.", sequence: 3, at: "" } }).status).toBe("failed");
  });
});

describe("store backup readiness (#166)", () => {
  const now = new Date(2026, 10, 10, 14, 32);
  const t = now.getTime();
  const active = {
    databaseOpen: true, schemaVersion: 1, latestSchemaVersion: 1, credentialStoreAvailable: true,
    enrollmentStatus: "active" as const,
  };
  const row = (storeBackups: { lastBackupAt: number | null; failures: number; failingSince: number | null }, over = {}) =>
    buildReadinessReport({ ...active, ...over, storeBackups }, now).checks.find((c) => c.id === "backups");

  it("shows the last backup, and nothing before the counter is enrolled", () => {
    expect(row({ lastBackupAt: t - 5 * 60_000, failures: 0, failingSince: null })).toEqual({
      id: "backups",
      label: "Store backups",
      status: "ok",
      detail: "Last backup 14:27 today. Backups stay on this computer.",
    });
    expect(row({ lastBackupAt: null, failures: 0, failingSince: null })?.detail).toBe("The first backup is being taken.");
    expect(row({ lastBackupAt: null, failures: 0, failingSince: null }, { enrollmentStatus: null })).toBeUndefined();
    expect(buildReadinessReport(active, now).checks.find((c) => c.id === "backups")).toBeUndefined();
  });

  it("warns once backups fail repeatedly, so a counter without backups never looks healthy", () => {
    // One failure may be a moment's contention; the next check retries it.
    expect(row({ lastBackupAt: t - 60 * 60_000, failures: 1, failingSince: t - 5 * 60_000 })?.status).toBe("ok");
    expect(row({ lastBackupAt: t - 60 * 60_000, failures: 3, failingSince: t - 15 * 60_000 })).toMatchObject({
      status: "warning",
      detail: "The last 3 backups failed (since 14:17 today). Last backup 13:32 today. Contact support: the app log says why.",
    });
    expect(row({ lastBackupAt: null, failures: 2, failingSince: t })?.detail).toContain("There is no backup on this computer.");
  });
});

describe("P2 #48 pre-outage readiness rows", () => {
  const now = new Date(2026, 10, 10, 14, 32);
  const t = now.getTime();
  const active = {
    databaseOpen: true, schemaVersion: 1, latestSchemaVersion: 1, credentialStoreAvailable: true,
    enrollmentStatus: "active" as const, preparedStaff: 2,
  };
  const refresh = { nominated: true, nominatedAt: t - 60_000, lastSuccessAt: t - 60_000, consecutiveFailures: 0, lastFailure: null, nextAttemptAt: null };
  const installed = {
    grantExpiresAt: t + 86_340_000, snapshotGeneratedAt: t - 120_000, authorizedStaff: 2, lines: 12,
    receiptNumbering: { prefix: "C1R", nextReceipt: "C1R-000042" },
    offlineManagers: { acknowledgeHours: ["Nadeesha Perera"], assistHandover: ["Nadeesha Perera", "Ruwan Silva"] },
  };
  const settled = { unresolvedCards: 0, approvedUnlinkedCards: 0, undelivered: 0, refused: 0 };
  const healthy = {
    ...active,
    offlineAuthority: { refresh, installed },
    printers: ["EPSON TM-T82III"],
    freeDiskBytes: 40 * 1024 ** 3,
    trustedClock: { trusted: true as const, nowMs: t, anchoredAt: t - 60_000, source: "sync_response" as const },
    offlineRecords: settled,
    journalSync: {
      configured: true,
      view: {
        recorded: 0, accepted: 0, waiting: 0, refused: 0, syncing: false, lastSuccessAt: new Date(t - 60_000).toISOString(),
        issue: null, outage: null, lastDrain: null, pause: null,
      },
    },
  };
  const check = (facts: Parameters<typeof buildReadinessReport>[0], id: string) =>
    buildReadinessReport(facts, now).checks.find((c) => c.id === id)!;

  it("is ready once every row is healthy", () => {
    const report = buildReadinessReport(healthy, now);
    expect(report.checks.filter((c) => c.status !== "ok")).toEqual([]);
    expect(report.ready).toBe(true);
  });

  it("reads receipt numbering from the installed offline permission", () => {
    expect(check(healthy, "receipt-numbers")).toMatchObject({
      status: "ok", detail: "Offline receipts use the series C1R. The next one is C1R-000042.",
    });
    expect(check({ ...healthy, offlineAuthority: { refresh, installed: null } }, "receipt-numbers")).toMatchObject({
      status: "not_ready", detail: expect.stringMatching(/^The receipt series comes with the offline permission\. Not received yet\./),
    });
    expect(check({ ...healthy, offlineAuthority: { refresh: null, installed: null } }, "receipt-numbers").detail)
      .toContain("no offline permission key");
    expect(check({ ...healthy, offlineAuthority: { refresh, installed: { ...installed, grantExpiresAt: t - 1 } } }, "receipt-numbers").status)
      .toBe("failed");
    expect(check({ ...healthy, enrollmentStatus: null }, "receipt-numbers").detail).toBe("Available once this device is activated.");
    // A renewal failing on a still-valid permission keeps the series usable.
    const failing = { ...refresh, consecutiveFailures: 1, lastFailure: { code: "NETWORK", at: t - 60_000 } };
    expect(check({ ...healthy, offlineAuthority: { refresh: failing, installed } }, "receipt-numbers").status).toBe("ok");
  });

  it("says the receipt series goes with the permission on a counter that is not the branch's offline backup", () => {
    const replaced = { ...refresh, nominated: false };
    // Still holding an unexpired permission: the series is not this counter's to use any more.
    expect(check({ ...healthy, offlineAuthority: { refresh: replaced, installed } }, "receipt-numbers")).toMatchObject({
      status: "failed", detail: expect.stringContaining("no longer the branch's offline backup"),
    });
    // Never nominated: nothing is on its way.
    expect(check({ ...healthy, offlineAuthority: { refresh: replaced, installed: null } }, "receipt-numbers")).toMatchObject({
      status: "not_ready", detail: expect.stringContaining("is not the branch's offline backup"),
    });
  });

  it("reads the printer from Windows' installed printers, leaving out the ones that can't print paper", () => {
    expect(check(healthy, "printer")).toMatchObject({ status: "ok", detail: expect.stringContaining("EPSON TM-T82III is installed in Windows.") });
    expect(check({ ...healthy, printers: ["A", "B"] }, "printer").detail).toContain("2 printers are (A, B) installed");
    expect(check({ ...healthy, printers: [] }, "printer")).toMatchObject({ status: "not_ready", detail: expect.stringContaining("No printer is installed") });
    expect(check({ ...healthy, printers: undefined }, "printer").status).toBe("not_ready");
    // What a Windows computer with no receipt printer lists.
    const builtIn = ["Microsoft Print to PDF", "Microsoft XPS Document Writer", "OneNote (Desktop)", "Fax"];
    expect(check({ ...healthy, printers: builtIn }, "printer")).toMatchObject({
      status: "not_ready", detail: expect.stringMatching(/^No receipt printer is installed in Windows on this computer: only Microsoft Print to PDF/),
    });
    expect(buildReadinessReport({ ...healthy, printers: builtIn }, now).ready).toBe(false);
    expect(check({ ...healthy, printers: [...builtIn, "EPSON TM-T82III"] }, "printer").detail).toMatch(/^EPSON TM-T82III is installed/);
    expect(check({ ...healthy, printers: undefined, printerLookupFailed: true }, "printer")).toMatchObject({
      status: "not_ready", detail: expect.stringContaining("Windows could not list its printers"),
    });
  });

  it("tells built-in file and app printers from receipt printers", () => {
    for (const name of ["Microsoft Print to PDF", "Microsoft XPS Document Writer", "OneNote for Windows 10", "Send To OneNote 2016", "Fax", "Adobe PDF"])
      expect(isVirtualPrinter(name)).toBe(true);
    for (const name of ["EPSON TM-T82III Receipt", "POS-80C", "XP-58", "Star TSP100"]) expect(isVirtualPrinter(name)).toBe(false);
  });

  it("shows whether offline selling has a trusted time", () => {
    expect(check(healthy, "clock")).toMatchObject({ status: "ok", detail: expect.stringContaining("last received 14:31 today") });
    expect(check({ ...healthy, trustedClock: { trusted: false, reason: "NO_ANCHOR" } }, "clock").status).toBe("not_ready");
  });

  it("treats a restart without the server's time as routine, and as a failure only during an outage", () => {
    const restarted = { ...healthy, trustedClock: { trusted: false as const, reason: "NEW_BOOT" as const } };
    expect(check(restarted, "clock")).toMatchObject({
      status: "not_ready",
      detail: "Windows restarted, or its clock was changed, since the server's time was last received. It arrives by itself once someone is signed in here and online.",
    });
    const outage = { ...restarted, journalSync: { ...healthy.journalSync, view: { ...healthy.journalSync.view, outage: { offlineSessionId: "o-1", startedAt: t - 60_000 } } } };
    expect(check(outage, "clock")).toMatchObject({
      status: "failed", detail: expect.stringContaining("Offline selling is stopped until this counter is online again"),
    });
  });

  it("warns about unsettled card money, approved-but-unlinked attempts included", () => {
    expect(check(healthy, "card-money").status).toBe("ok");
    expect(check({ ...healthy, offlineRecords: { ...settled, unresolvedCards: 3, approvedUnlinkedCards: 1 } }, "card-money")).toMatchObject({
      status: "warning",
      detail: expect.stringMatching(/^3 card payments are not settled: 1 approved with no sale linked, 2 with no card machine result recorded\./),
    });
    expect(check({ ...healthy, offlineRecords: { ...settled, unresolvedCards: 1, approvedUnlinkedCards: 1 } }, "card-money").detail)
      .toMatch(/^1 card payment is not settled: 1 approved with no sale linked\./);
  });

  it("warns about support records waiting to upload and fails on refused ones", () => {
    expect(check(healthy, "support-records").status).toBe("ok");
    expect(check({ ...healthy, offlineRecords: { ...settled, undelivered: 2 } }, "support-records")).toMatchObject({
      status: "warning", detail: expect.stringMatching(/^2 notes or card records are waiting to upload\./),
    });
    expect(check({ ...healthy, offlineRecords: { ...settled, undelivered: 3, refused: 1 } }, "support-records")).toMatchObject({
      status: "failed",
      detail: expect.stringMatching(/^The server turned down 1 note or card record\. It will not clear by itself: contact support\. 2 notes/),
    });
  });
});

describe("P2 #48 offline manager cover and disk space", () => {
  const now = new Date(2026, 10, 19, 10, 0);
  const t = now.getTime();
  const base = {
    databaseOpen: true, schemaVersion: 1, latestSchemaVersion: 1, credentialStoreAvailable: true,
    enrollmentStatus: "active" as const, preparedStaff: 3,
  };
  const refresh = { nominated: true, nominatedAt: t - 60_000, lastSuccessAt: t - 60_000, consecutiveFailures: 0, lastFailure: null, nextAttemptAt: null };
  const installed = (acknowledgeHours: string[], assistHandover: string[]) => ({
    grantExpiresAt: t + 86_340_000, snapshotGeneratedAt: t - 120_000, authorizedStaff: 3, lines: 12,
    receiptNumbering: { prefix: "C1R", nextReceipt: "C1R-000001" },
    offlineManagers: { acknowledgeHours, assistHandover },
  });
  const row = (facts: Parameters<typeof buildReadinessReport>[0], id: string) =>
    buildReadinessReport(facts, now).checks.find((c) => c.id === id);

  it("names who can allow after-hours selling and close an absent cashier's shift offline", () => {
    expect(row({ ...base, offlineAuthority: { refresh, installed: installed(["Ruwan", "Amal"], ["Nadeesha"]) } }, "offline-managers")).toEqual({
      id: "offline-managers",
      label: "Offline manager cover",
      status: "ok",
      detail: "Ruwan and Amal can allow selling after hours offline. Nadeesha can close an absent cashier's shift offline.",
    });
  });

  it("warns, with what to do, when nobody prepared here can do a manager task offline", () => {
    expect(row({ ...base, offlineAuthority: { refresh, installed: installed(["Ruwan"], []) } }, "offline-managers")).toMatchObject({
      status: "warning",
      detail:
        "Ruwan can allow selling after hours offline. Nobody here can close an absent cashier's shift while offline. A manager whose role allows it prepares their PIN on this counter while it is online.",
    });
    expect(row({ ...base, offlineAuthority: { refresh, installed: installed([], []) } }, "offline-managers")!.status).toBe("warning");
  });

  it("waits for the offline permission, and for activation", () => {
    expect(row({ ...base, offlineAuthority: { refresh, installed: null } }, "offline-managers")).toMatchObject({
      status: "not_ready", detail: "Comes with the offline permission.",
    });
    expect(row({ ...base, enrollmentStatus: null }, "offline-managers")).toMatchObject({
      status: "not_ready", detail: "Available once this device is activated.",
    });
  });

  it("reads names from the grant's staff, leaving out anyone not prepared here", () => {
    const staff = (id: string, actions: Array<"acknowledge_business_hours" | "assist_shift_handover">) => ({
      staffUserId: id, staffAuthorizationId: `auth-${id}`, credentialVersion: 1, signInMethod: "personal_pin" as const, offlineManagerActions: actions,
    });
    const names: Record<string, string> = { a: "Ruwan", b: "Amal", c: "Nadeesha" };
    expect(
      offlineManagerNames(
        [staff("a", ["acknowledge_business_hours", "assist_shift_handover"]), staff("b", ["acknowledge_business_hours"]), staff("c", []), staff("gone", ["assist_shift_handover"])],
        (id) => names[id] ?? null,
      ),
    ).toEqual({ acknowledgeHours: ["Amal", "Ruwan"], assistHandover: ["Ruwan"] });
  });

  it("shows free disk space, warning before it is low and failing before it is full", () => {
    expect(row({ ...base, freeDiskBytes: 40 * 1024 ** 3 }, "disk")).toEqual({
      id: "disk", label: "Disk space", status: "ok", detail: "40.0 GB free on the drive that holds this counter's records.",
    });
    expect(row({ ...base, freeDiskBytes: DISK_WARNING_BYTES - 1 }, "disk")).toMatchObject({
      status: "warning", detail: "Only 1023 MB free on the drive that holds this counter's records. Free up space before it fills, or contact support.",
    });
    expect(row({ ...base, freeDiskBytes: DISK_FAILED_BYTES - 1 }, "disk")).toMatchObject({
      status: "failed", detail: expect.stringContaining("Sales stop when it fills"),
    });
    expect(row({ ...base, freeDiskBytes: null }, "disk")).toMatchObject({ status: "warning", detail: expect.stringContaining("could not say") });
    // Not looked at (no store open): no row at all.
    expect(row(base, "disk")).toBeUndefined();
  });
});
