import { join, resolve, sep } from "node:path";
import { ipcContract } from "../shared/ipc-contract";
import { checkApi } from "./api-check";
import { renderTestReceiptHtml } from "./printing/receipt-html";
import { buildReadinessReport, clockTime, explainRefreshFailure } from "./readiness";
import { isAppUrl, resolveRendererFile } from "./renderer-path";

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
      expect.arrayContaining(["database", "grant", "device", "catalogue", "receipt-numbers", "printer", "sync"]),
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
  const installed = { grantExpiresAt: t + 86_340_000, snapshotGeneratedAt: t - 120_000, authorizedStaff: 4, lines: 412 };
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
      "drain_incomplete", "invalid", "NETWORK", "HTTP_502", "WEIRD",
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
    pause: null as { reason: "draining" | "unsynced"; waiting: number; outageStartedAt: number | null } | null,
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
    expect(sync({ recorded: 3, waiting: 3, pause: { reason: "draining", waiting: 3, outageStartedAt: t - 600_000 } })).toMatchObject({
      status: "warning",
      detail: "Synchronising offline sales: new sales wait until it finishes. 3 offline records waiting to reach the server.",
    });
    expect(sync({ recorded: 3, accepted: 3, pause: { reason: "draining", waiting: 0, outageStartedAt: t - 600_000 } }).detail)
      .toContain("Waiting for fresh stock from the server.");
  });

  it("fails on a refused record or a journal the server doesn't recognise", () => {
    const refused = sync({
      recorded: 5, accepted: 3, waiting: 2, refused: 1,
      issue: { code: "LOCAL_STOCK_EXHAUSTED", message: "A manager reviews it in the back office.", sequence: 4, at: "" },
      pause: { reason: "draining", waiting: 2, outageStartedAt: t },
    });
    expect(refused).toMatchObject({ status: "failed", detail: "A manager reviews it in the back office. 2 offline records waiting to reach the server." });
    expect(sync({ issue: { code: "JOURNAL_MISMATCH", message: "Contact support.", sequence: 3, at: "" } }).status).toBe("failed");
  });
});
