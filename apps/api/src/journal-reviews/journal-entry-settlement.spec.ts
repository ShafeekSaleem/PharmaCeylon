import type {
  BranchStockSnapshot,
  OfflineJournalCommand,
  OfflineSaleCommand,
  OfflineShiftCloseCommand,
  OfflineStaffSignIn,
} from "@pharmaceylon/shared";
import {
  RECORD_BLOCKER_MESSAGES,
  SETTLE_BLOCKER_MESSAGES,
  isoOrNull,
  notHonourBlocker,
  notHonouredEffect,
  parseDecision,
  parseReason,
  recordedSaleError,
  recordedOccurredAt,
  refusalExplanation,
  signInMatches,
} from "./journal-entry-settlement";

/** P5 #51 slice 4: what may be recorded as it happened when a manager settles a refused entry. */
describe("journal entry settlement rules", () => {
  const identity = {
    tenantId: "t",
    branchId: "b",
    terminalId: "x",
    enrollmentId: "e",
    keyId: "k",
  };
  const snapshot = {
    contractVersion: 1,
    kind: "branch_stock_snapshot",
    snapshotId: "snap",
    snapshotVersion: 1,
    identity,
    generatedAt: 0,
    includedThroughSequence: 0,
    includedThroughHash: null,
    lines: [
      {
        snapshotLineId: "l1",
        productId: "p1",
        batchId: "b1",
        availableQuantity: 5,
        stockReviewRequired: false,
        unitPriceMinor: 1550,
        taxBasisPoints: 1800,
        sellBefore: 0,
      },
      {
        snapshotLineId: "l2",
        productId: "p2",
        batchId: "b2",
        availableQuantity: 1,
        stockReviewRequired: true,
        unitPriceMinor: 333,
        taxBasisPoints: 0,
        sellBefore: 0,
      },
    ],
  } as BranchStockSnapshot;
  // 2 x 15.50 = 31.00, 18% tax = 5.58 → 36.58
  const sale = (overrides: Partial<OfflineSaleCommand> = {}) =>
    ({
      kind: "ordinary_sale",
      currency: "LKR",
      snapshotId: "snap",
      lines: [
        {
          snapshotLineId: "l1",
          quantity: 2,
          unitPriceMinor: 1550,
          discountMinor: 0,
          taxMinor: 558,
        },
      ],
      payments: [
        {
          method: "cash",
          amountMinor: 3658,
          tenderedMinor: 4000,
          changeMinor: 342,
        },
      ],
      totalMinor: 3658,
      ...overrides,
    }) as OfflineSaleCommand;

  it("records a sale whose figures are exactly the snapshot's, whatever rule it broke", () => {
    expect(recordedSaleError(sale(), snapshot)).toBeNull();
    // A batch under review in the snapshot is the rule broken (RECONCILIATION_REQUIRED), not the money.
    expect(
      recordedSaleError(
        sale({
          lines: [
            {
              snapshotLineId: "l2",
              quantity: 3,
              unitPriceMinor: 333,
              discountMinor: 0,
              taxMinor: 0,
            },
          ],
          payments: [
            {
              method: "external_card",
              amountMinor: 999,
              providerReference: "AUTH-1",
              approvalCode: "A1",
              approvedAt: 0,
            },
          ],
          totalMinor: 999,
        }),
        snapshot,
      ),
    ).toBeNull();
  });

  it("refuses lines outside the snapshot, repeated lines and changed prices, tax or discounts", () => {
    const line = {
      snapshotLineId: "l1",
      quantity: 2,
      unitPriceMinor: 1550,
      discountMinor: 0,
      taxMinor: 558,
    };
    expect(
      recordedSaleError(
        sale({ lines: [{ ...line, snapshotLineId: "nope" }] }),
        snapshot,
      ),
    ).toBe("lines_unknown");
    expect(
      recordedSaleError(
        sale({
          lines: [line, line],
          totalMinor: 7316,
          payments: [
            {
              method: "cash",
              amountMinor: 7316,
              tenderedMinor: 7316,
              changeMinor: 0,
            },
          ],
        }),
        snapshot,
      ),
    ).toBe("lines_unknown");
    expect(
      recordedSaleError(
        sale({ lines: [{ ...line, unitPriceMinor: 1500 }] }),
        snapshot,
      ),
    ).toBe("prices_differ");
    expect(
      recordedSaleError(
        sale({ lines: [{ ...line, taxMinor: 557 }] }),
        snapshot,
      ),
    ).toBe("prices_differ");
    expect(
      recordedSaleError(
        sale({ lines: [{ ...line, discountMinor: 10 }] }),
        snapshot,
      ),
    ).toBe("prices_differ");
  });

  it("refuses totals and payments that don't add up", () => {
    expect(recordedSaleError(sale({ totalMinor: 3659 }), snapshot)).toBe(
      "totals_differ",
    );
    expect(
      recordedSaleError(sale({ currency: "USD" as "LKR" }), snapshot),
    ).toBe("totals_differ");
    expect(recordedSaleError(sale({ payments: [] }), snapshot)).toBe(
      "totals_differ",
    );
    expect(
      recordedSaleError(
        sale({
          payments: [
            {
              method: "cash",
              amountMinor: 3658,
              tenderedMinor: 4000,
              changeMinor: 300,
            },
          ],
        }),
        snapshot,
      ),
    ).toBe("payments_differ");
    expect(
      recordedSaleError(
        sale({
          payments: [
            {
              method: "cash",
              amountMinor: 3000,
              tenderedMinor: 3000,
              changeMinor: 0,
            },
          ],
        }),
        snapshot,
      ),
    ).toBe("payments_differ");
    expect(
      recordedSaleError(
        sale({
          payments: [
            {
              method: "external_card",
              amountMinor: 3658,
              providerReference: "  ",
              approvalCode: "A1",
              approvedAt: 0,
            },
          ],
        }),
        snapshot,
      ),
    ).toBe("payments_differ");
  });

  it("dates a recorded entry no later than the server first saw it", () => {
    const received = new Date(1_700_000_000_000);
    expect(recordedOccurredAt(1_699_999_000_000, received).getTime()).toBe(
      1_699_999_000_000,
    );
    // A clock ahead of the server (CLOCK_UNTRUSTED) is clamped to when it arrived.
    expect(recordedOccurredAt(1_700_000_900_000, received)).toEqual(received);
    // A broken clock that gives no date at all is dated when it arrived too.
    expect(recordedOccurredAt(-9e15, received)).toEqual(received);
    expect(recordedOccurredAt(Number.MAX_SAFE_INTEGER, received)).toEqual(
      received,
    );
  });

  it("formats a counter timestamp, or null where it is no date at all", () => {
    expect(isoOrNull(0)).toBe("1970-01-01T00:00:00.000Z");
    expect(isoOrNull(8.64e15)).toBe("+275760-09-13T00:00:00.000Z");
    expect(isoOrNull(8.64e15 + 1)).toBeNull();
    expect(isoOrNull(Number.MAX_SAFE_INTEGER)).toBeNull();
    expect(isoOrNull(1.5)).toBeNull();
  });

  describe("the sign-in an entry cites", () => {
    const session = {
      registerId: "r",
      tillId: "t1",
      workSessionId: "w",
      staffUserId: "cashier",
    };
    const signIn = (over: Partial<OfflineStaffSignIn> = {}) =>
      ({
        staffSignInId: "s1",
        identity,
        session,
        ...over,
      }) as OfflineStaffSignIn;
    const entry = (over: Partial<OfflineJournalCommand> = {}) =>
      ({
        kind: "ordinary_sale",
        staffSignInId: "s1",
        session,
        ...over,
      }) as OfflineJournalCommand;

    it("matches only this counter's sign-in for the entry's own person and shift", () => {
      expect(signInMatches(identity, entry(), signIn())).toBe(true);
      expect(
        signInMatches(identity, entry({ staffSignInId: "s2" }), signIn()),
      ).toBe(false);
      expect(
        signInMatches(
          identity,
          entry(),
          signIn({ identity: { ...identity, enrollmentId: "other" } }),
        ),
      ).toBe(false);
      // Someone else signed in, or the same person on another shift.
      expect(
        signInMatches(
          identity,
          entry(),
          signIn({ session: { ...session, staffUserId: "manager" } }),
        ),
      ).toBe(false);
      expect(
        signInMatches(
          identity,
          entry(),
          signIn({ session: { ...session, workSessionId: "w2" } }),
        ),
      ).toBe(false);
    });

    it("lets an assisted close be signed in by the manager who closed it, on the same till", () => {
      const assisted = entry({
        kind: "shift_close",
        assistance: { managerSignInId: "s1", reason: "Cashier left ill" },
      } as Partial<OfflineShiftCloseCommand>);
      const manager = signIn({
        session: { ...session, workSessionId: "mw", staffUserId: "manager" },
      });
      expect(signInMatches(identity, assisted, manager)).toBe(true);
      // The cashier can't assist their own close, and the manager must be at this till.
      expect(signInMatches(identity, assisted, signIn())).toBe(false);
      expect(
        signInMatches(
          identity,
          assisted,
          signIn({
            session: { ...session, tillId: "t2", staffUserId: "manager" },
          }),
        ),
      ).toBe(false);
    });
  });

  describe("not honouring", () => {
    it("records a shift record the till can take, rather than stranding its shift", () => {
      expect(notHonourBlocker("shift_open", true)).toBe("shift_recordable");
      expect(notHonourBlocker("shift_close", true)).toBe("shift_recordable");
      expect(notHonourBlocker("shift_open", false)).toBeNull();
      // A sale may always be not honoured.
      expect(notHonourBlocker("ordinary_sale", true)).toBeNull();
    });

    it("says what follows, and that card money is kept as collected, not sold", () => {
      expect(notHonouredEffect(sale(), null)).toMatch(/shift's variance\.$/);
      const card = sale({
        payments: [
          {
            method: "external_card",
            amountMinor: 3658,
            providerReference: "TID-42",
            approvalCode: "A1",
            approvedAt: 0,
          },
        ],
      });
      expect(notHonouredEffect(card, null)).toMatch(
        /kept as collected, not sold/,
      );
      const open = { kind: "shift_open" } as OfflineJournalCommand;
      expect(notHonouredEffect(open, "till_has_open_shift")).toMatch(
        /close the shift still open on this till first/,
      );
      expect(notHonouredEffect(open, "grant_unknown")).toMatch(
        /only be not honoured too/,
      );
      const close = { kind: "shift_close" } as OfflineJournalCommand;
      expect(notHonouredEffect(close, "shift_not_open")).toMatch(
        /nothing else waits/,
      );
      expect(notHonouredEffect(close, "sign_in_mismatch")).toMatch(
        /stays open on the server/,
      );
    });
  });

  it("requires a decision and a reason", () => {
    expect(parseDecision("recorded")).toBe("recorded");
    expect(parseDecision("not_honoured")).toBe("not_honoured");
    expect(() => parseDecision("voided")).toThrow();
    expect(parseReason("  Owner confirmed the cash  ")).toBe(
      "Owner confirmed the cash",
    );
    expect(() => parseReason("   ")).toThrow();
    expect(() => parseReason(undefined)).toThrow();
    expect(() => parseReason("x".repeat(501))).toThrow();
  });

  it("explains every refusal and every blocker in words", () => {
    expect(refusalExplanation("GRANT_EXPIRED")).toMatch(/24-hour/);
    expect(refusalExplanation("SOMETHING_NEW")).toContain("SOMETHING_NEW");
    for (const message of [
      ...Object.values(RECORD_BLOCKER_MESSAGES),
      ...Object.values(SETTLE_BLOCKER_MESSAGES),
    ])
      expect(message.length).toBeGreaterThan(10);
  });
});
