import { describe, expect, it } from "@jest/globals";
import type {
  JournalSync,
  OfflineJournalEntry,
  OfflineJournalQueue,
  OfflineModeState,
} from "../../shared/ipc-contract";
import {
  DRAIN_NOTICE_MS,
  entryStatus,
  lastOfflineSale,
  queueChip,
  queueHeading,
  queuePhase,
  reconnectNotice,
  serverBlockReason,
} from "./reconnect-model";

/** P4 #50, slice 4c: what the counter says about its offline sales after reconnecting. */

const NOW = Date.parse("2026-11-17T10:58:00.000Z");

function entry(
  sequence: number,
  over: Partial<OfflineJournalEntry> = {},
): OfflineJournalEntry {
  return {
    commandId: `cmd-${sequence}`,
    sequence,
    kind: "sale",
    at: "2026-11-17T10:50:00.000Z",
    receiptNumber: `C1R-${String(170 + sequence).padStart(6, "0")}`,
    totalMinor: 69_200,
    status: "accepted",
    stockReview: false,
    notHonoured: false,
    refusalCode: null,
    printable: true,
    ...over,
  };
}
const queue = (...entries: OfflineJournalEntry[]): OfflineJournalQueue => ({
  entries,
  more: false,
});

const journal = (over: Partial<JournalSync> = {}): JournalSync => ({
  recorded: 16,
  accepted: 13,
  waiting: 3,
  refused: 0,
  syncing: false,
  lastSuccessAt: null,
  issue: null,
  pause: null,
  lastDrainAt: null,
  lastStockDownloadAt: null,
  stockDownloadNominated: true,
  ...over,
});
const pause = (waiting: number, cards = 0): JournalSync["pause"] => ({
  reason: "draining",
  waiting,
  outageStartedAt: "2026-11-17T10:13:00.000Z",
  unconfirmed: { sales: 0, actions: 0 },
  holds: { cards, records: 0, refused: 0 },
});

const mode = (over: Partial<OfflineModeState>): OfflineModeState => ({
  mode: "online",
  reason: null,
  clock: null,
  connected: true,
  outageStartedAt: null,
  grantExpiresAt: "2026-11-18T08:12:00.000Z",
  snapshotGeneratedAt: "2026-11-17T10:11:00.000Z",
  ...over,
});

const queued = queue(
  entry(16, { status: "queued" }),
  entry(15, { status: "queued" }),
  entry(14, { status: "queued" }),
  entry(13, {
    kind: "shift_open",
    receiptNumber: null,
    totalMinor: null,
    printable: false,
  }),
);
const sending = queue(
  entry(16, { status: "sending" }),
  entry(15, { status: "sending" }),
  entry(14),
);
const refused = queue(
  entry(16, { status: "waiting" }),
  entry(15, { status: "refused", refusalCode: "REPLAY_CONFLICT" }),
  entry(14),
);

describe("the upload queue", () => {
  it("waits to upload while offline (d-queue)", () => {
    const phase = queuePhase(
      mode({ mode: "offline", connected: false }),
      journal(),
      queued,
    );
    expect(phase).toBe("offline");
    expect(queueChip(phase, journal(), queued)).toBe("3 to send");
    expect(queueHeading("offline", journal(), queued)).toEqual({
      title: "Waiting to upload",
      text: "3 sales saved on this counter, waiting for the connection.",
      footer:
        "Uploads start by themselves when this counter is back online. You don't need to retry a queued sale.",
    });
  });

  it("synchronises once the connection is back, and checkout stays paused (d-drain)", () => {
    const sync = journal({ waiting: 2, pause: pause(2) });
    const phase = queuePhase(mode({ mode: "draining" }), sync, sending);
    expect(phase).toBe("draining");
    expect(queueChip(phase, sync, sending)).toBe("2 to send");
    const heading = queueHeading("draining", sync, sending);
    expect(heading.title).toBe("Synchronising offline sales");
    expect(heading.text).toBe(
      "2 records to send. No unconfirmed card payments.",
    );
    expect(heading.footer).toContain(
      "Checkout stays paused on this counter until this list is clear and a fresh stock snapshot is installed.",
    );
    expect(
      queueHeading(
        "draining",
        journal({ pause: pause(0, 1) }),
        queue(entry(14)),
      ).text,
    ).toBe(
      "Every record is on the server. 1 card payment still to be settled.",
    );
  });

  it("needs a manager review after a refusal, and stays paused until it is settled on the web (Q4)", () => {
    const sync = journal({ refused: 1, pause: pause(2) });
    const phase = queuePhase(mode({ mode: "draining" }), sync, refused);
    expect(phase).toBe("review");
    expect(queueChip(phase, sync, refused)).toBe("2 need review");
    const heading = queueHeading("review", sync, refused);
    expect(heading.title).toBe("Needs a manager review");
    expect(heading.text).toBe(
      "The server refused journal entry 15. Nothing after it can be accepted until a manager settles it on the web.",
    );
    expect(heading.footer).toContain("stays paused until then");
    expect(heading.footer).not.toMatch(/checkout can continue/i);
  });

  it("says nothing with nothing to send", () => {
    expect(
      queuePhase(mode({}), journal({ waiting: 0 }), queue(entry(14))),
    ).toBeNull();
    expect(queueChip(null, journal(), queue())).toBeNull();
  });

  it("falls back to the journal's counts before the list arrives", () => {
    expect(
      queuePhase(mode({ mode: "offline", connected: false }), journal(), null),
    ).toBe("offline");
    expect(queueChip("offline", journal(), null)).toBe("3 to send");
  });

  it("words each entry's chip; stock under review never says why (Q3)", () => {
    expect(entryStatus(entry(1, { status: "queued" })).label).toBe("Queued");
    expect(entryStatus(entry(1, { status: "sending" })).label).toBe("Sending");
    expect(entryStatus(entry(1, { status: "waiting" })).label).toBe("Waiting");
    expect(entryStatus(entry(1, { status: "refused" }))).toEqual({
      label: "Needs review",
      tone: "bad",
    });
    expect(entryStatus(entry(1, { stockReview: true }))).toEqual({
      label: "Stock under review",
      tone: "warn",
    });
    expect(entryStatus(entry(1))).toEqual({
      label: "Accepted",
      tone: "neutral",
    });
    expect(entryStatus(entry(1), "last").label).toBe("Uploaded");
  });

  it("finds the newest sale, past shift entries", () => {
    expect(
      lastOfflineSale(
        queue(
          entry(3, { kind: "shift_close", receiptNumber: null }),
          entry(2),
          entry(1),
        ),
      )?.sequence,
    ).toBe(2);
    expect(lastOfflineSale(null)).toBeNull();
  });
});

describe("reconnectNotice", () => {
  it("is quiet with no offline history", () => {
    expect(reconnectNotice(journal({ waiting: 0 }), queue(), NOW)).toBeNull();
    expect(reconnectNotice(null, null, NOW)).toBeNull();
  });

  it("says checkout waits while the records upload (d-drain)", () => {
    const notice = reconnectNotice(journal({ pause: pause(4) }), sending, NOW);
    expect(notice).toMatchObject({
      tone: "info",
      title: "Waiting to finish offline sales",
      dismissible: false,
    });
    expect(notice?.text).toContain("until the 4 saved records are accepted");
    expect(notice?.text).toContain("fresh stock is installed");
  });

  it("names the refused entry and keeps the counter paused until a manager settles it (d-review, Q4)", () => {
    const notice = reconnectNotice(
      journal({ refused: 1, pause: pause(2) }),
      refused,
      NOW,
    );
    expect(notice).toMatchObject({
      tone: "warn",
      title: "2 sales need a manager review",
      dismissible: false,
    });
    expect(notice?.text).toContain(
      "Entry 15 (receipt C1R-000185) was refused (REPLAY_CONFLICT).",
    );
    expect(notice?.text).toContain(
      "stays paused until a manager settles it on the web",
    );
    expect(notice?.text).not.toMatch(/checkout can continue/i);
  });

  it("says stock under review only, never why (d-stock, Q3)", () => {
    const sync = journal({
      waiting: 0,
      lastDrainAt: new Date(NOW - 60_000).toISOString(),
    });
    const notice = reconnectNotice(
      sync,
      queue(entry(16), entry(15, { stockReview: true })),
      NOW,
    );
    expect(notice).toMatchObject({ tone: "warn", dismissible: true });
    expect(notice?.title).toContain("Stock under review");
    expect(notice?.text).toContain("C1R-000185");
    expect(notice?.text).not.toMatch(/stocktake|counted|twice|deducted/i);
  });

  it("says the receipt number is unchanged once everything is accepted (d-clean)", () => {
    const sync = journal({
      waiting: 0,
      lastDrainAt: new Date(NOW - 60_000).toISOString(),
    });
    expect(reconnectNotice(sync, queue(entry(16), entry(15)), NOW)).toEqual({
      tone: "ok",
      title: "All offline sales were accepted",
      text: "Fresh stock is installed. Checkout is open again. Receipt C1R-000186 is unchanged.",
      dismissible: true,
    });
  });

  it("stops saying so after a while", () => {
    const sync = journal({
      waiting: 0,
      lastDrainAt: new Date(NOW - DRAIN_NOTICE_MS - 1).toISOString(),
    });
    expect(reconnectNotice(sync, queue(entry(16)), NOW)).toBeNull();
  });
});

describe("serverBlockReason (#212 note 4)", () => {
  it("doesn't promise to keep the sale on the counter that is about to sell offline", () => {
    const reason = serverBlockReason(mode({ mode: "online" }));
    expect(reason?.text).toContain("switches to offline selling");
    expect(reason?.text).toContain("isn't carried over");
    expect(reason?.text).not.toContain("is kept");
  });

  it("leaves the generic words to a counter with no offline authority", () => {
    expect(
      serverBlockReason(
        mode({ grantExpiresAt: null, snapshotGeneratedAt: null }),
      ),
    ).toBeNull();
    expect(serverBlockReason(null)).toBeNull();
  });

  it("keeps saying why a counter can't sell offline", () => {
    expect(
      serverBlockReason(
        mode({ mode: "stopped", reason: "GRANT_EXPIRED", connected: false }),
      )?.text,
    ).toContain("permission has run out");
  });
});
