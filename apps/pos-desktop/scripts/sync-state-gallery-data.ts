import type { JournalSync } from "../src/shared/ipc-contract";
import { SYNC_STALE_MS, deriveSyncState } from "../src/renderer/src/connection-sync";

const now = new Date("2026-11-11T09:14:16.000Z");
const apiOk = { reachable: true, checkedAt: "2026-11-11T09:14:05.000Z", latencyMs: 5 };
const apiDown = { reachable: false, checkedAt: "2026-11-11T09:14:05.000Z", latencyMs: 0 };

const journal = (over: Partial<JournalSync> = {}): JournalSync => ({
  recorded: 0,
  accepted: 0,
  waiting: 0,
  refused: 0,
  syncing: false,
  lastSuccessAt: "2026-11-11T09:14:08.000Z",
  issue: null,
  pause: null,
  lastDrainAt: null,
  lastStockDownloadAt: "2026-11-11T09:10:00.000Z",
  stockDownloadNominated: true,
  ...over,
});

function connClass(tone: string): string {
  if (tone === "wait") return "connWait";
  if (tone === "info") return "connInfo";
  if (tone === "warn") return "connWarn";
  if (tone === "bad") return "connBad";
  return "";
}

function sbClass(tone: string): string {
  if (tone === "wait") return "sbWait";
  if (tone === "info") return "sbInfo";
  if (tone === "warn") return "sbWarn";
  if (tone === "bad") return "sbBad";
  return "sbOk";
}

function render(d: NonNullable<ReturnType<typeof deriveSyncState>>) {
  const pillDetail = d.titleDetail ? `<span class="connDetail"> · ${d.titleDetail}</span>` : "";
  const pillHtml = `<span class="dot"></span>${d.titleLead}${pillDetail}`;
  const statusInner = [
    `<span class="d"></span><b>${d.statusLead}</b>`,
    ...d.statusParts.map((p) => {
      const cls = p.tone === "warn" ? "sbWarnText" : p.tone === "muted" ? "sbMuted" : "";
      return `<span class="${cls}"> · ${p.text}</span>`;
    }),
  ].join("");
  return {
    connClass: connClass(d.tone),
    sbClass: sbClass(d.tone),
    pillHtml,
    statusHtml: statusInner,
  };
}

const fixtures: Array<{ id: string; d: ReturnType<typeof deriveSyncState> }> = [
  { id: "0", d: deriveSyncState("active", apiOk, journal({ stockDownloadNominated: null, lastStockDownloadAt: null }), now, false) },
  { id: "1", d: deriveSyncState("active", null, journal({ stockDownloadNominated: null, lastStockDownloadAt: null }), now, false) },
  { id: "2", d: deriveSyncState("active", apiOk, journal({ syncing: true, stockDownloadNominated: null, lastStockDownloadAt: null }), now, true) },
  { id: "3", d: deriveSyncState("active", apiOk, journal({ lastSuccessAt: null, stockDownloadNominated: null, lastStockDownloadAt: null }), now, false) },
  { id: "4", d: deriveSyncState("active", apiDown, journal({ lastSuccessAt: null, stockDownloadNominated: null, lastStockDownloadAt: null }), now, false) },
  { id: "5", d: deriveSyncState("active", apiDown, journal({ lastSuccessAt: "2026-11-11T09:02:08.000Z", stockDownloadNominated: null, lastStockDownloadAt: null }), now, false) },
  { id: "5b", d: deriveSyncState("active", apiDown, journal({ lastSuccessAt: "2026-11-09T18:05:41.000Z", stockDownloadNominated: null, lastStockDownloadAt: null }), now, false) },
  { id: "6", d: deriveSyncState("active", apiOk, journal({ lastSuccessAt: new Date(now.getTime() - SYNC_STALE_MS - 3_600_000).toISOString(), stockDownloadNominated: null, lastStockDownloadAt: null }), now, false) },
  { id: "T1", d: deriveSyncState("active", apiOk, journal(), now, false) },
  { id: "T2", d: deriveSyncState("active", apiOk, journal({ lastStockDownloadAt: "2026-11-11T08:42:00.000Z" }), now, false) },
  { id: "T3", d: deriveSyncState("active", apiOk, journal({ lastStockDownloadAt: null }), now, false) },
  { id: "2-waiting", d: deriveSyncState("active", apiOk, journal({ waiting: 3 }), now, false) },
  { id: "T4", d: deriveSyncState("active", apiOk, journal({ lastSuccessAt: "2026-11-11T07:00:00.000Z" }), now, false) },
  { id: "T5", d: deriveSyncState("active", apiOk, journal({ lastSuccessAt: "2026-11-11T07:00:00.000Z", lastStockDownloadAt: "2026-11-11T06:58:00.000Z" }), now, false) },
  { id: "T6", d: deriveSyncState("active", apiDown, journal(), now, false) },
  { id: "T7", d: deriveSyncState("active", apiOk, journal({ stockDownloadNominated: false, lastStockDownloadAt: null }), now, false) },
];

const out = fixtures.filter((f) => f.d).map((f) => ({ id: f.id, ...render(f.d!) }));
process.stdout.write(JSON.stringify(out));
