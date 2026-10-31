import { join, resolve, sep } from "node:path";
import { ipcContract } from "../shared/ipc-contract";
import { checkApi } from "./api-check";
import { renderTestReceiptHtml } from "./printing/receipt-html";
import { buildReadinessReport } from "./readiness";
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
