/**
 * P4 #50, slice 4c: the real `App` on fixture bridge answers, for the reconnect captures
 * (`d-queue`, `d-drain`, `d-review`, `d-stock`, `d-clean`). Built only into screenshot.html
 * (`?reconnect=<shot>`); never shipped in the Electron app. Calls it doesn't answer never resolve,
 * so pages that aren't shown stay as they are while loading.
 */
import type {
  ApiReachability,
  CatalogView,
  DeviceState,
  JournalSync,
  OfflineJournalEntry,
  OfflineJournalQueue,
  OfflineModeState,
  OfflineStaff,
  ShiftState,
} from "../../shared/ipc-contract";
import { emptyEnrollmentOfflineBackup } from "../../shared/ipc-contract";

export const RECONNECT_SHOTS = [
  "queue",
  "drain",
  "review",
  "stock",
  "clean",
  // A counter that isn't the branch's offline counter, with the server out of reach (d-other).
  "other",
] as const;
export type ReconnectShot = (typeof RECONNECT_SHOTS)[number];

export function reconnectShot(search: string): ReconnectShot | null {
  const shot = new URLSearchParams(search).get("reconnect");
  return (RECONNECT_SHOTS as readonly string[]).includes(shot ?? "")
    ? (shot as ReconnectShot)
    : null;
}

const ids = {
  nimal: "00000000-0000-4000-8000-000000000011",
  branch: "00000000-0000-4000-8000-0000000000b1",
  register: "00000000-0000-4000-8000-0000000000c1",
  till: "00000000-0000-4000-8000-0000000000d1",
  session: "00000000-0000-4000-8000-0000000000e1",
};

/** Today at hh:mm, local time: the fixture's sales happened this afternoon. */
function today(hours: number, minutes: number): string {
  const d = new Date();
  d.setHours(hours, minutes, 0, 0);
  return d.toISOString();
}

const session = {
  workSessionId: ids.session,
  staffUserId: ids.nimal,
  staffName: "Nimal Perera",
  openedAt: today(8, 14),
};

const device: DeviceState = {
  serverUrl: "https://pos.pharmaceylon.lk/api/v1",
  serverUrlEditable: true,
  enrollment: {
    status: "active",
    branchId: ids.branch,
    branchName: "Kandy",
    branchCode: "KDY",
    registerId: ids.register,
    tillId: ids.till,
    counterLabel: "Counter 1",
    label: "Front counter PC",
    terminalId: ids.till,
    enrollmentId: ids.register,
    enrolledAt: "2026-10-14T00:00:00.000Z",
    enrolledByUserId: ids.nimal,
    enrolledByName: "Dilini Fernando",
    offlineBackup: emptyEnrollmentOfflineBackup,
    enrollmentFactsLive: true,
    enrollmentStatusFetchedAt: null,
  },
  operator: null,
  staffSession: session,
  pin: { set: true, prepared: true, lockedUntil: null },
  locked: false,
  counterStaff: [
    {
      staffUserId: ids.nimal,
      staffName: "Nimal Perera",
      role: "cashier",
      state: "signed_in",
      lockedUntil: null,
    },
  ],
  branches: [],
  windowsSession: { protocol: "console", remoteSession: false },
};

const shift: ShiftState = {
  current: {
    workSessionId: ids.session,
    shiftNumber: "S-0418",
    staffUserId: ids.nimal,
    staffName: "Nimal Perera",
    openedAt: today(8, 14),
    openingCashMinor: 500_000,
    openingCount: [{ denominationMinor: 100_000, count: 5 }],
    status: "open",
    sync: "synced",
    error: null,
    expectedCashMinor: 1_735_200,
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
  },
  lastClosed: null,
  unsynced: [],
};

function entry(
  sequence: number,
  hh: number,
  mm: number,
  totalMinor: number | null,
  over: Partial<OfflineJournalEntry> = {},
): OfflineJournalEntry {
  const sale = totalMinor !== null;
  return {
    commandId: `00000000-0000-4000-8000-0000000001${String(sequence).padStart(2, "0")}`,
    sequence,
    kind: sale ? "sale" : "shift_open",
    at: today(hh, mm),
    receiptNumber: sale
      ? `C1R-${String(170 + sequence).padStart(6, "0")}`
      : null,
    totalMinor,
    status: "accepted",
    stockReview: false,
    notHonoured: false,
    refusalCode: null,
    printable: sale,
    ...over,
  };
}

function queueFor(shot: ReconnectShot): OfflineJournalQueue {
  const s = (
    status: OfflineJournalEntry["status"],
    over: Partial<OfflineJournalEntry> = {},
  ) => ({
    status,
    ...over,
  });
  const rows: Record<ReconnectShot, OfflineJournalEntry[]> = {
    queue: [
      entry(16, 16, 20, 69_200, s("queued")),
      entry(15, 16, 11, 124_000, s("queued")),
      entry(14, 16, 2, 42_000, s("queued")),
      entry(13, 8, 14, null),
    ],
    drain: [
      entry(16, 16, 20, 69_200, s("sending")),
      entry(15, 16, 11, 124_000, s("sending")),
      entry(14, 16, 2, 42_000),
      entry(13, 8, 14, null),
    ],
    review: [
      entry(16, 16, 20, 69_200, s("waiting")),
      entry(
        15,
        16,
        11,
        124_000,
        s("refused", { refusalCode: "REPLAY_CONFLICT" }),
      ),
      entry(14, 16, 2, 42_000),
      entry(13, 8, 14, null),
    ],
    stock: [
      entry(16, 16, 20, 69_200),
      entry(15, 16, 11, 124_000, { stockReview: true }),
      entry(14, 16, 2, 42_000),
      entry(13, 8, 14, null),
    ],
    clean: [
      entry(16, 16, 20, 69_200),
      entry(15, 16, 11, 124_000),
      entry(14, 16, 2, 42_000),
      entry(13, 8, 14, null),
    ],
    other: [],
  };
  return { entries: rows[shot], more: false };
}

function journalFor(shot: ReconnectShot): JournalSync {
  const waiting =
    shot === "queue" ? 3 : shot === "drain" ? 2 : shot === "review" ? 2 : 0;
  const pause =
    shot === "drain" || shot === "review"
      ? {
          reason: "draining" as const,
          waiting,
          outageStartedAt: today(15, 48),
          unconfirmed: { sales: 0, actions: 0 },
          holds: { cards: 0, records: 0, refused: 0 },
        }
      : null;
  return {
    recorded: 16,
    accepted: 16 - waiting,
    waiting,
    refused: shot === "review" ? 1 : 0,
    syncing: shot === "drain",
    lastSuccessAt:
      shot === "queue"
        ? today(15, 41)
        : new Date(Date.now() - 8_000).toISOString(),
    issue:
      shot === "review"
        ? {
            code: "REPLAY_CONFLICT",
            message: "A manager reviews the refused entry in the back office.",
          }
        : null,
    pause,
    lastDrainAt:
      shot === "stock" || shot === "clean"
        ? new Date(Date.now() - 60_000).toISOString()
        : null,
    lastStockDownloadAt:
      shot === "stock" || shot === "clean"
        ? new Date(Date.now() - 30_000).toISOString()
        : today(15, 41),
    stockDownloadNominated: true,
  };
}

function modeFor(shot: ReconnectShot): OfflineModeState {
  return {
    mode:
      shot === "queue"
        ? "offline"
        : shot === "drain" || shot === "review"
          ? "draining"
          : shot === "other"
            ? "stopped"
            : "online",
    reason: shot === "other" ? "NO_OFFLINE_AUTHORITY" : null,
    clock: null,
    connected: shot !== "queue" && shot !== "other",
    outageStartedAt:
      shot === "queue" || shot === "drain" || shot === "review"
        ? today(15, 48)
        : null,
    grantExpiresAt: new Date(Date.now() + 16 * 3_600_000).toISOString(),
    snapshotGeneratedAt: today(15, 41),
  };
}

const catalog: CatalogView = {
  vatRatePercent: 0,
  maxDiscountPercent: 10,
  products: [
    ["Panadol 500mg Tablets", "500mg", "Strip of 12", "96.00", 18],
    ["Piriton 4mg Tablets", "4mg", "Strip of 10", "80.00", 40],
    ["Jeevanee ORS Sachet", null, "Sachet", "35.00", 40],
    ["Siddhalepa Balm 25g", null, "Jar", "360.00", 12],
    ["Link Samahan", null, "Sachet", "45.00", 22],
    ["Dettol Antiseptic 250ml", null, "Bottle", "420.00", 9],
  ].map(([name, strength, unit, unitPrice, available], i) => ({
    productId: `00000000-0000-4000-8000-0000000002${String(i).padStart(2, "0")}`,
    name: name as string,
    sku: null,
    barcode: null,
    strength: strength as string | null,
    unit: unit as string,
    unitPrice: unitPrice as string,
    available: available as number,
    needsPharmacist: false,
    requiresPrescription: false,
    isControlled: false,
  })),
};

const offlineStaff: OfflineStaff = {
  signedIn: {
    staffUserId: ids.nimal,
    staffName: "Nimal Perera",
    signedInAt: today(15, 50),
    workSessionId: ids.session,
  },
  people: [
    {
      staffUserId: ids.nimal,
      staffName: "Nimal Perera",
      canAssistClose: false,
      canAcknowledgeHours: false,
      lockRemainingMs: 0,
    },
  ],
  hours: { status: "open" },
};

const offlineStock = catalog.products.map((p, i) => ({
  snapshotLineId: `line-${i}`,
  productId: p.productId,
  batchId: `batch-${i}`,
  remaining: p.available,
  unitPriceMinor: Math.round(Number(p.unitPrice) * 100),
  sellBefore: Date.now() + 90 * 86_400_000,
  blocked: null,
  display: {
    name: p.name,
    strength: p.strength,
    barcode: null,
    batchNo: `PN24${i}9`,
  },
}));

/** Installs the fixture bridge for one shot. */
export function installReconnectFixture(shot: ReconnectShot) {
  const ok = <T,>(value: T) => Promise.resolve({ ok: true as const, value });
  const api: ApiReachability = {
    reachable: shot !== "queue" && shot !== "other",
    checkedAt: new Date().toISOString(),
    latencyMs: shot === "queue" ? null : 14,
  };
  const answers: Record<string, () => Promise<unknown>> = {
    getAppInfo: () =>
      Promise.resolve({
        appVersion: "1.0.0",
        electronVersion: "44.7.0",
        schemaVersion: 27,
        packaged: false,
      }),
    getReadiness: () =>
      Promise.resolve({
        ready: true,
        checkedAt: new Date().toISOString(),
        checks: [],
        offlineBackup: null,
      }),
    getDeviceState: () => Promise.resolve(device),
    listPrinters: () =>
      Promise.resolve([
        { name: "EPSON_TM_T82III", displayName: "EPSON TM-T82III" },
      ]),
    checkApi: () => Promise.resolve(api),
    getShift: () => Promise.resolve(shift),
    refreshShift: () => ok(shift),
    getJournalSync: () => Promise.resolve(journalFor(shot)),
    getOfflineMode: () => Promise.resolve(modeFor(shot)),
    getOfflineJournalQueue: () => Promise.resolve(queueFor(shot)),
    catalog: () => ok(catalog),
    listHolds: () => ok([]),
    pendingCheckouts: () => Promise.resolve([]),
    offlineStaff: () => Promise.resolve(offlineStaff),
    offlineStock: () => ok(offlineStock),
    counterWork: () => ok([]),
  };
  const pos = new Proxy({} as Record<string, unknown>, {
    get: (_target, name) => {
      if (typeof name !== "string" || name === "then") return undefined;
      return answers[name] ?? (() => new Promise(() => undefined));
    },
  });
  Object.defineProperty(window, "pos", {
    value: pos,
    configurable: true,
    writable: true,
  });
}
