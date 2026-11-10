import type { HttpException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  parseCounterRestoreReport,
  parseCounterRestoreStatusRequest,
  parseCounterRestoreUpload,
} from "./counter-restore-wire";

/** P5 #51, store backup and restore: what a restored counter may send. */

const hash = (c: string) => c.repeat(64);
const identity = {
  tenantId: randomUUID(),
  branchId: randomUUID(),
  terminalId: randomUUID(),
  enrollmentId: randomUUID(),
  keyId: "key-1",
};
const report = (over: Record<string, unknown> = {}) => ({
  contractVersion: 1,
  kind: "offline_counter_restore_report",
  restoreId: randomUUID(),
  identity,
  reportedAt: 3_000,
  backupId: "20261110T100005000Z-abcd1234",
  backupTakenAt: 1_000,
  restoredAt: 2_000,
  journalHead: { sequence: 4, hash: hash("a") },
  acceptedWatermark: { sequence: 2, hash: hash("b") },
  outageActive: true,
  removedGrantVersion: 3,
  ...over,
});
const envelope = (payload: unknown, keyId = identity.keyId) => ({
  algorithm: "Ed25519",
  keyId,
  payload,
  signature: Buffer.alloc(64, 7).toString("base64url"),
});
function refusal(parse: () => unknown): string | null {
  try {
    parse();
    return null;
  } catch (error) {
    return (
      ((error as HttpException).getResponse() as { code?: string }).code ??
      "unknown"
    );
  }
}

describe("counter restore wire", () => {
  it("parses a restore report exactly as signed", () => {
    const sent = report();
    expect(parseCounterRestoreReport(sent)).toEqual(sent);
    expect(
      parseCounterRestoreReport(
        report({ removedGrantVersion: null, outageActive: false }),
      ),
    ).toMatchObject({
      removedGrantVersion: null,
      outageActive: false,
    });
    const fresh = report({
      journalHead: { sequence: 0, hash: null },
      acceptedWatermark: { sequence: 0, hash: null },
    });
    expect(parseCounterRestoreReport(fresh)).toEqual(fresh);
  });

  it("refuses a report that is malformed or says something impossible", () => {
    for (const bad of [
      report({ kind: "offline_journal_recovery_report" }),
      report({ contractVersion: 2 }),
      report({ restoreId: "not-a-uuid" }),
      report({ backupId: "" }),
      report({ backupId: "../pos.db" }),
      report({ backupId: "x".repeat(65) }),
      report({ outageActive: "yes" }),
      report({ removedGrantVersion: 0 }),
      report({ removedGrantVersion: 1.5 }),
      report({ backupTakenAt: 2_001 }),
      report({ reportedAt: -1 }),
      // The server never confirmed past the journal the counter holds.
      report({ acceptedWatermark: { sequence: 5, hash: hash("b") } }),
      report({ journalHead: { sequence: 4, hash: null } }),
      { ...report(), extra: true },
    ])
      expect(refusal(() => parseCounterRestoreReport(bad))).toBe(
        "INVALID_COMMAND",
      );
  });

  it("takes one device-signed envelope whose key is the report's own", () => {
    const sent = report();
    expect(
      parseCounterRestoreUpload({ report: envelope(sent) }).payload,
    ).toEqual(sent);
    expect(
      refusal(() =>
        parseCounterRestoreUpload({ report: envelope(sent, "key-2") }),
      ),
    ).toBe("INVALID_COMMAND");
    expect(
      refusal(() =>
        parseCounterRestoreUpload({ report: envelope(sent), extra: 1 }),
      ),
    ).toBe("INVALID_COMMAND");
    expect(refusal(() => parseCounterRestoreUpload(envelope(sent)))).toBe(
      "INVALID_COMMAND",
    );
  });

  it("parses a status request", () => {
    const restoreId = randomUUID();
    expect(parseCounterRestoreStatusRequest({ identity, restoreId })).toEqual({
      identity,
      restoreId,
    });
    expect(
      refusal(() =>
        parseCounterRestoreStatusRequest({ identity, restoreId: "x" }),
      ),
    ).toBe("INVALID_COMMAND");
    expect(refusal(() => parseCounterRestoreStatusRequest({ identity }))).toBe(
      "INVALID_COMMAND",
    );
  });
});
