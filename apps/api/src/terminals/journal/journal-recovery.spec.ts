import type { HttpException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { continuesJournalChain } from "@pharmaceylon/shared";
import type { AuthorityCutoff } from "../grant-cutoff";
import {
  journalHalfCleared,
  maySignOff,
  signOffAvailableAt,
  signOffCurrent,
} from "./journal-recovery-evidence";
import {
  parseChainRequest,
  parsePosition,
  parseRecoveryCompletion,
  parseRecoveryReport,
} from "./journal-recovery-wire";

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
  kind: "offline_journal_recovery_report",
  reportId: randomUUID(),
  identity,
  reportedAt: 1_000,
  serverHead: { sequence: 5, hash: hash("a") },
  commonPrefix: { sequence: 3, hash: hash("b") },
  localHead: { sequence: 3, hash: hash("b") },
  ...over,
});
/** The refusal code a parser throws, or null if it parsed. */
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

describe("journal recovery wire", () => {
  it("parses positions: sequence 0 has no hash, every other one names a digest", () => {
    expect(parsePosition({ sequence: 0, hash: null })).toEqual({
      sequence: 0,
      hash: null,
    });
    expect(parsePosition({ sequence: 2, hash: hash("c") })).toEqual({
      sequence: 2,
      hash: hash("c"),
    });
    for (const bad of [
      { sequence: 0, hash: hash("c") },
      { sequence: 2, hash: null },
      { sequence: 2, hash: "C".repeat(64) },
      { sequence: -1, hash: null },
      { sequence: 1.5, hash: hash("c") },
      { sequence: 1, hash: hash("c"), extra: true },
    ])
      expect(refusal(() => parsePosition(bad))).toBe("INVALID_COMMAND");
  });

  it("accepts a restored computer that is a prefix of the server's chain, and one that forked", () => {
    expect(parseRecoveryReport(report())).toMatchObject({
      commonPrefix: { sequence: 3 },
    });
    expect(
      parseRecoveryReport(
        report({ localHead: { sequence: 7, hash: hash("d") } }),
      ),
    ).toMatchObject({
      localHead: { sequence: 7 },
    });
  });

  it("refuses reports that cannot describe a difference", () => {
    for (const over of [
      // the common prefix is past either head
      { commonPrefix: { sequence: 6, hash: hash("b") } },
      {
        commonPrefix: { sequence: 4, hash: hash("b") },
        localHead: { sequence: 3, hash: hash("b") },
      },
      // the two heads are the same journal
      {
        localHead: { sequence: 5, hash: hash("a") },
        commonPrefix: { sequence: 5, hash: hash("a") },
      },
      // a local head at the common prefix must be that entry
      { localHead: { sequence: 3, hash: hash("e") } },
      { kind: "offline_journal_recovery_completion" },
      { contractVersion: 2 },
      { reportId: "not-a-uuid" },
      { unmatchedHashes: [] },
    ])
      expect(refusal(() => parseRecoveryReport(report(over)))).toBe(
        "INVALID_COMMAND",
      );
  });

  it("parses a completion that removed offline authority, and nothing else", () => {
    const completion = {
      contractVersion: 1,
      kind: "offline_journal_recovery_completion",
      recoveryId: randomUUID(),
      identity,
      completedAt: 2_000,
      journalHead: { sequence: 5, hash: hash("a") },
      setAsideThrough: { sequence: 3, hash: hash("b") },
      offlineAuthorityRemoved: true,
    };
    expect(parseRecoveryCompletion(completion)).toEqual(completion);
    expect(
      refusal(() =>
        parseRecoveryCompletion({
          ...completion,
          offlineAuthorityRemoved: false,
        }),
      ),
    ).toBe("INVALID_COMMAND");
  });

  it("bounds chain pages", () => {
    expect(
      parseChainRequest({ identity, afterSequence: 0, limit: 100 }),
    ).toMatchObject({ limit: 100 });
    for (const limit of [0, 101])
      expect(
        refusal(() => parseChainRequest({ identity, afterSequence: 0, limit })),
      ).toBe("INVALID_COMMAND");
  });

  it("checks chain links from a position", () => {
    const entries = [
      { sequence: 4, previousCommandHash: hash("b") },
      { sequence: 5, previousCommandHash: hash("c") },
    ];
    expect(
      continuesJournalChain({ sequence: 3, hash: hash("b") }, entries, [
        hash("c"),
        hash("d"),
      ]),
    ).toBe(true);
    expect(
      continuesJournalChain({ sequence: 3, hash: hash("b") }, entries, [
        hash("x"),
        hash("d"),
      ]),
    ).toBe(false);
    expect(
      continuesJournalChain({ sequence: 2, hash: hash("b") }, entries, [
        hash("c"),
        hash("d"),
      ]),
    ).toBe(false);
    expect(
      continuesJournalChain(
        { sequence: 0, hash: null },
        [{ sequence: 1, previousCommandHash: null }],
        [hash("a")],
      ),
    ).toBe(true);
  });
});

describe("D11 missing-journal sign-off (decisions of 2026-11-10)", () => {
  const head = { sequence: 4, hash: hash("a") };
  const revoked: AuthorityCutoff = {
    kind: "device_disabled",
    at: 1_000,
    lastGrantExpiresAt: 5_000,
  };
  const expired: AuthorityCutoff = {
    kind: "grants_expire",
    at: 5_000,
    lastGrantExpiresAt: 5_000,
  };
  const never: AuthorityCutoff = {
    kind: "never_issued",
    at: null,
    lastGrantExpiresAt: null,
  };

  it("waits out the last grant, even for a revoked counter", () => {
    expect(signOffAvailableAt(revoked)).toBe(5_000);
    expect(maySignOff(revoked, 4_999)).toBe(false);
    expect(maySignOff(revoked, 5_000)).toBe(true);
    expect(maySignOff(expired, 5_000)).toBe(true);
  });

  it("is available at once when no grant was ever issued, but still needs a person", () => {
    expect(signOffAvailableAt(never)).toBeNull();
    expect(maySignOff(never, 0)).toBe(true);
    expect(
      journalHalfCleared(null, {
        nominationVersion: 1,
        head: { sequence: 0, hash: null },
        cutoff: never,
      }),
    ).toBe(false);
  });

  it("covers exactly the nomination, accepted head and grants it saw", () => {
    const signOff = { nominationVersion: 2, head, approvedAt: 6_000 };
    const now = { nominationVersion: 2, head, cutoff: expired };
    expect(signOffCurrent(signOff, now)).toBe(true);
    expect(journalHalfCleared(signOff, now)).toBe(true);
    expect(signOffCurrent(signOff, { ...now, nominationVersion: 3 })).toBe(
      false,
    );
    expect(
      signOffCurrent(signOff, {
        ...now,
        head: { sequence: 5, hash: hash("b") },
      }),
    ).toBe(false);
    expect(
      signOffCurrent(signOff, {
        ...now,
        head: { sequence: 4, hash: hash("b") },
      }),
    ).toBe(false);
    // A grant issued after the sign-off (the old counter renewed) makes it stale.
    expect(
      signOffCurrent(signOff, {
        ...now,
        cutoff: { kind: "grants_expire", at: 9_000, lastGrantExpiresAt: 9_000 },
      }),
    ).toBe(false);
  });
});
