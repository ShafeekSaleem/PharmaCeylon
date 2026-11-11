import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { commandText, sha256 } from "../terminal-wire";
import { journalHash, parseCommandEnvelope, parseJournalCommand, parseSyncRequest, MAX_SYNC_COMMANDS } from "./offline-journal-wire";

const identity = { tenantId: randomUUID(), branchId: randomUUID(), terminalId: randomUUID(), enrollmentId: randomUUID(), keyId: "key-1" };
const context = (sequence = 1) => ({
  contractVersion: 1,
  commandId: randomUUID(),
  identity,
  session: { registerId: randomUUID(), tillId: randomUUID(), workSessionId: randomUUID(), staffUserId: randomUUID() },
  staffSignInId: randomUUID(),
  sequence,
  previousCommandHash: sequence === 1 ? null : "a".repeat(64),
  occurredAt: 1_700_000_000_000,
  grantId: randomUUID(),
  grantVersion: 1,
  nominationVersion: 1,
  offlineSessionId: randomUUID(),
  offlineStartedAt: 1_699_999_999_000,
  businessHoursAcknowledgementId: null,
});
const sale = (overrides: Record<string, unknown> = {}) => ({
  ...context(),
  kind: "ordinary_sale",
  snapshotId: randomUUID(),
  snapshotVersion: 1,
  currency: "LKR",
  lines: [{ snapshotLineId: randomUUID(), quantity: 2, unitPriceMinor: 1550, discountMinor: 0, taxMinor: 558 }],
  payments: [{ method: "cash", amountMinor: 3658, tenderedMinor: 4000, changeMinor: 342 }],
  totalMinor: 3658,
  ...overrides,
});
const envelope = (payload: unknown) => ({ algorithm: "Ed25519", keyId: "key-1", payload, signature: "A".repeat(86) });

describe("offline journal wire (P5 #51)", () => {
  it("hashes an entry exactly as the desktop does: the shared golden vector", () => {
    const vector = JSON.parse(
      readFileSync(join(__dirname, "../../../../../packages/shared/test/journal-command-hash.json"), "utf8"),
    ) as { payload: unknown; hash: string };
    expect(journalHash(vector.payload)).toBe(vector.hash);
  });

  it("parses the three command kinds with their exact keys", () => {
    expect(parseJournalCommand(sale()).kind).toBe("ordinary_sale");
    expect(parseJournalCommand({ ...context(), kind: "shift_open", currency: "LKR", openingCashMinor: 0, previousClosedWorkSessionId: null }).kind).toBe("shift_open");
    expect(parseJournalCommand({
      ...context(2), kind: "shift_close", currency: "LKR", closingCashCountMinor: 100, expectedCashMinor: -50,
      assistance: { managerSignInId: randomUUID(), reason: "Cashier left" },
    }).kind).toBe("shift_close");
  });

  it("refuses unknown or missing fields, wrong discriminators and inexact numbers", () => {
    expect(() => parseJournalCommand({ ...sale(), extra: true })).toThrow();
    const { totalMinor: _omit, ...missing } = sale();
    expect(() => parseJournalCommand(missing)).toThrow();
    expect(() => parseJournalCommand(sale({ kind: "refund" }))).toThrow();
    expect(() => parseJournalCommand(sale({ currency: "USD" }))).toThrow();
    expect(() => parseJournalCommand(sale({ totalMinor: 36.58 }))).toThrow();
    expect(() => parseJournalCommand(sale({ lines: [] }))).toThrow();
    expect(() => parseJournalCommand(sale({ payments: [{ method: "mobile_wallet", amountMinor: 3658 }] }))).toThrow();
    expect(() => parseJournalCommand(sale({ payments: [{ method: "cash", amountMinor: 3658, tenderedMinor: 4000, changeMinor: 342, pan: "4111" }] }))).toThrow();
  });

  it("requires the chain to start with null at sequence 1 and a digest after it", () => {
    expect(() => parseJournalCommand(sale({ previousCommandHash: "a".repeat(64) }))).toThrow();
    expect(() => parseJournalCommand(sale({ sequence: 2, previousCommandHash: null }))).toThrow();
    expect(() => parseJournalCommand(sale({ sequence: 2, previousCommandHash: "A".repeat(64) }))).toThrow();
    expect(parseJournalCommand(sale({ sequence: 2, previousCommandHash: "b".repeat(64) })).sequence).toBe(2);
  });

  it("binds the envelope key to the command's identity and hashes the signed bytes", () => {
    const payload = sale();
    const parsed = parseCommandEnvelope(envelope(payload));
    expect(parsed.hash).toBe(sha256(commandText(payload)));
    expect(journalHash(payload)).toBe(parsed.hash);
    expect(() => parseCommandEnvelope({ ...envelope(payload), keyId: "other" })).toThrow();
  });

  it("bounds the request and its lists", () => {
    const body = { contractVersion: 1, identity, staffSignIns: [], commands: [], supportRecords: [] };
    expect(parseSyncRequest(body).identity).toEqual(identity);
    expect(() => parseSyncRequest({ ...body, contractVersion: 2 })).toThrow();
    expect(() => parseSyncRequest({ ...body, commands: Array(MAX_SYNC_COMMANDS + 1).fill({}) })).toThrow();
    expect(() => parseSyncRequest({ ...body, extra: [] })).toThrow();
  });

  it("accepts each upload page up to the shared cap so a long journal is sent in batches", () => {
    const body = { contractVersion: 1, identity, staffSignIns: [], commands: [], supportRecords: [] };
    const unsynced = MAX_SYNC_COMMANDS + 8;
    const pages = [
      Array(MAX_SYNC_COMMANDS).fill({}),
      Array(unsynced - MAX_SYNC_COMMANDS).fill({}),
    ];
    for (const commands of pages) {
      expect(parseSyncRequest({ ...body, commands }).commands).toHaveLength(commands.length);
    }
    expect(() => parseSyncRequest({ ...body, commands: Array(unsynced).fill({}) })).toThrow();
  });
});
