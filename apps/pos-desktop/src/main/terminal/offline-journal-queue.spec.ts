import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import type { SecretProtector } from "../db/key-store";
import { migrations } from "../db/migrations";
import { openLocalStore, type LocalStore } from "../local-store";
import type { OfflineJournalEntry } from "../../shared/ipc-contract";
import { readOfflineJournalQueue } from "./offline-journal-queue";

/** P4 #50, slice 4c: the title bar's upload queue, read from the local journal. */

const protector: SecretProtector = {
  isAvailable: () => true,
  protect: (p) => Buffer.from(p),
  unprotect: (b) => b.toString(),
};
const ENROLLMENT = randomUUID();
const OTHER_ENROLLMENT = randomUUID();
const T0 = Date.UTC(2026, 10, 17, 10, 0);
const hash = (n: number) => n.toString(16).padStart(64, "0");

let dir: string;
let local: LocalStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pos-journal-queue-"));
  local = openLocalStore(dir, protector, migrations);
});
afterEach(() => {
  local.db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

type Entry = {
  sequence: number;
  kind?: "ordinary_sale" | "shift_open" | "shift_close";
  outage?: string;
  status?: "pending" | "synced" | "failed";
  ack?: object | null;
  error?: string | null;
  receipt?: boolean;
  enrollmentId?: string;
};

function add({
  sequence,
  kind = "ordinary_sale",
  outage = "outage-2",
  status = "pending",
  ack = null,
  error = null,
  receipt = kind === "ordinary_sale",
  enrollmentId = ENROLLMENT,
}: Entry): string {
  const commandId = randomUUID();
  const payload = {
    kind,
    commandId,
    sequence,
    occurredAt: T0 + sequence * 60_000,
    offlineSessionId: outage,
    ...(kind === "ordinary_sale"
      ? {
          receiptNumber: `C1R-${String(170 + sequence).padStart(6, "0")}`,
          totalMinor: sequence * 10_000,
        }
      : {}),
  };
  local.db
    .prepare(
      `INSERT INTO offline_journal_command
         (command_id, enrollment_id, sequence, previous_hash, payload_hash, envelope_json, sync_status,
          created_at, acknowledgement_json, last_error_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      commandId,
      enrollmentId,
      sequence,
      sequence === 1 ? null : hash(sequence - 1),
      hash(sequence),
      JSON.stringify({
        algorithm: "Ed25519",
        keyId: "k",
        signature: "s",
        payload,
      }),
      status,
      new Date(T0).toISOString(),
      ack ? JSON.stringify(ack) : null,
      error,
    );
  if (receipt)
    local.db
      .prepare(
        `INSERT INTO offline_sale_receipt (checkout_draft_id, enrollment_id, command_id, receipt_number, receipt_json, created_at)
         VALUES (?, ?, ?, ?, '{}', ?)`,
      )
      .run(
        randomUUID(),
        enrollmentId,
        commandId,
        payload.receiptNumber ?? null,
        new Date(T0).toISOString(),
      );
  return commandId;
}

const committed = (stock: "posted" | "pending_reconciliation" = "posted") => ({
  status: "committed",
  commandKind: "ordinary_sale",
  stockPosting: stock,
  reconciliationCaseId: stock === "posted" ? null : randomUUID(),
});

describe("readOfflineJournalQueue", () => {
  it("is empty with no journal", () => {
    expect(
      readOfflineJournalQueue(local.db, ENROLLMENT, { connected: true }),
    ).toEqual({
      entries: [],
      more: false,
    });
  });

  it("lists the latest outage newest first, queued while offline", () => {
    add({
      sequence: 12,
      kind: "shift_close",
      outage: "outage-1",
      status: "synced",
      ack: { status: "committed" },
    });
    add({
      sequence: 13,
      kind: "shift_open",
      status: "synced",
      ack: { status: "committed" },
    });
    add({ sequence: 14 });
    add({ sequence: 15 });
    const sale = add({ sequence: 16 });
    add({ sequence: 1, enrollmentId: OTHER_ENROLLMENT });

    const queue = readOfflineJournalQueue(local.db, ENROLLMENT, {
      connected: false,
    });
    expect(queue.more).toBe(false);
    expect(queue.entries.map((e) => [e.sequence, e.kind, e.status])).toEqual([
      [16, "sale", "queued"],
      [15, "sale", "queued"],
      [14, "sale", "queued"],
      [13, "shift_open", "accepted"],
    ]);
    expect(queue.entries[0]).toEqual({
      commandId: sale,
      sequence: 16,
      kind: "sale",
      at: new Date(T0 + 16 * 60_000).toISOString(),
      receiptNumber: "C1R-000186",
      totalMinor: 160_000,
      status: "queued",
      stockReview: false,
      notHonoured: false,
      refusalCode: null,
      printable: true,
    });
    // A shift entry has no receipt or total.
    expect(queue.entries[3]).toMatchObject({
      receiptNumber: null,
      totalMinor: null,
      printable: false,
    });
  });

  it("says sending while connected, and accepted once acknowledged", () => {
    add({
      sequence: 1,
      kind: "shift_open",
      status: "synced",
      ack: { status: "committed" },
    });
    add({ sequence: 2, status: "synced", ack: committed() });
    add({ sequence: 3 });
    const statuses = readOfflineJournalQueue(local.db, ENROLLMENT, {
      connected: true,
    }).entries.map((e) => e.status);
    expect(statuses).toEqual(["sending", "accepted", "accepted"]);
  });

  it("keeps a held entry sending: the server will look at it again", () => {
    add({ sequence: 1, error: "TEMPORARILY_UNAVAILABLE" });
    add({ sequence: 2 });
    const queue = readOfflineJournalQueue(local.db, ENROLLMENT, {
      connected: true,
    });
    expect(queue.entries.map((e) => [e.status, e.refusalCode])).toEqual([
      ["sending", null],
      ["sending", null],
    ]);
  });

  it("marks a refused entry and everything after it waiting (Q4)", () => {
    add({
      sequence: 13,
      kind: "shift_open",
      status: "synced",
      ack: { status: "committed" },
    });
    add({ sequence: 14, status: "synced", ack: committed() });
    add({ sequence: 15, status: "failed", error: "REPLAY_CONFLICT" });
    add({ sequence: 16 });
    const queue = readOfflineJournalQueue(local.db, ENROLLMENT, {
      connected: true,
    });
    expect(
      queue.entries.map((e) => [e.sequence, e.status, e.refusalCode]),
    ).toEqual([
      [16, "waiting", null],
      [15, "refused", "REPLAY_CONFLICT"],
      [14, "accepted", null],
      [13, "accepted", null],
    ]);
  });

  it("flags stock under review without saying why (Q3), and a refused entry not honoured", () => {
    add({
      sequence: 1,
      status: "synced",
      ack: committed("pending_reconciliation"),
    });
    add({
      sequence: 2,
      status: "synced",
      ack: {
        status: "reviewed",
        commandKind: "ordinary_sale",
        decision: "not_honoured",
      },
    });
    add({
      sequence: 3,
      status: "synced",
      ack: {
        ...committed("pending_reconciliation"),
        status: "reviewed",
        decision: "recorded",
      },
    });
    const [third, second, first] = readOfflineJournalQueue(
      local.db,
      ENROLLMENT,
      {
        connected: true,
      },
    ).entries as [
      OfflineJournalEntry,
      OfflineJournalEntry,
      OfflineJournalEntry,
    ];
    expect([first.stockReview, first.notHonoured]).toEqual([true, false]);
    expect([second.stockReview, second.notHonoured]).toEqual([false, true]);
    expect([third.stockReview, third.notHonoured]).toEqual([true, false]);
    expect(Object.keys(first)).not.toContain("reason");
  });

  it("keeps unsent entries of an earlier outage in the list", () => {
    add({
      sequence: 1,
      outage: "outage-1",
      status: "synced",
      ack: committed(),
    });
    add({ sequence: 2, outage: "outage-1" });
    add({ sequence: 3, outage: "outage-2" });
    const sequences = readOfflineJournalQueue(local.db, ENROLLMENT, {
      connected: false,
    }).entries.map((e) => e.sequence);
    expect(sequences).toEqual([3, 2]);
  });

  it("lists at most the limit, and says there are more", () => {
    for (let n = 1; n <= 5; n += 1) add({ sequence: n });
    const queue = readOfflineJournalQueue(local.db, ENROLLMENT, {
      connected: false,
      limit: 3,
    });
    expect(queue.entries.map((e) => e.sequence)).toEqual([5, 4, 3]);
    expect(queue.more).toBe(true);
  });

  it("says a sale whose receipt this computer no longer holds can't be reprinted", () => {
    add({ sequence: 1, receipt: false });
    expect(
      readOfflineJournalQueue(local.db, ENROLLMENT, { connected: true })
        .entries[0]?.printable,
    ).toBe(false);
  });
});
