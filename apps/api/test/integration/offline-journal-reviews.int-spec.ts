import { randomBytes, randomUUID, verify } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
  terminalSigningText,
  type SyncAcknowledgement,
} from "@pharmaceylon/shared";
import { JournalReviewsService } from "../../src/journal-reviews/journal-reviews.service";
import { ManagementApprovalsService } from "../../src/security/management-approvals.service";
import { acceptedJournalState } from "../../src/terminals/offline-authority-issuance";
import { commandText, sha256 } from "../../src/terminals/terminal-wire";
import {
  access,
  audit,
  counter,
  offlineJournal,
  onHand,
  prisma,
  server,
  shifts,
  stock,
  sync,
  trust,
  type Counter,
} from "./offline-counter.kit";

/**
 * P5 #51 slice 4: a manager settles an offline journal entry the server rejected (record it as it
 * happened, or don't honour it), exactly approved and remote, so the counter finishes syncing.
 */
const approvals = new ManagementApprovalsService(access, audit);
const reviews = new JournalReviewsService(
  prisma as never,
  audit,
  access,
  approvals,
  stock,
  shifts,
);

const branch = (c: Counter) => c.fx.mainBranchId;
const hour = 60 * 60 * 1000;
const statuses = (acks: readonly SyncAcknowledgement[]) =>
  acks.map((a) => a.status);
const reviewOf = async (c: Counter, commandId: string) =>
  (
    await prisma.offlineJournalReview.findFirstOrThrow({
      where: {
        tenantId: c.fx.tenantId,
        recordId: commandId,
        outcome: "rejected",
      },
    })
  ).id;
const stuck = (c: Counter) =>
  prisma.$transaction((tx) => acceptedJournalState(tx, c.identity));

async function selfApproval(c: Counter, roles: string[]) {
  await prisma.tenantSettings.upsert({
    where: { tenantId: c.fx.tenantId },
    create: { tenantId: c.fx.tenantId, selfApprovalRoleKeys: roles },
    update: { selfApprovalRoleKeys: roles },
  });
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe("refused offline journal entries (P5 #51 slice 4)", () => {
  it("a sale made after the grant expired: recorded as it happened, pending on a case, and the counter carries on", async () => {
    const c = await counter({ late: 10, other: 10 });
    const j = offlineJournal(c);
    const workSessionId = randomUUID();
    const cashierIn = j.signIn(c.cashier.userId, workSessionId);
    const open = j.open(cashierIn, 0);
    const late = j.sale(cashierIn, [[c.batches.late, 2]], {
      occurredAt: c.grant.expiresAt,
    });
    const next = j.sale(cashierIn, [[c.batches.other, 1]]);
    const afterExpiry = c.grant.expiresAt + hour;

    const first = await sync(
      c,
      { staffSignIns: [cashierIn], commands: [open, late] },
      afterExpiry,
    );
    expect(statuses(first.payload.acknowledgements)).toEqual([
      "committed",
      "rejected",
    ]);
    expect(first.payload.acknowledgements[1]).toMatchObject({
      error: { code: "GRANT_EXPIRED" },
    });
    // Stuck: nothing after it can be accepted, and the counter gets no new authority.
    await expect(stuck(c)).rejects.toMatchObject({
      response: { code: "RECONCILIATION_REQUIRED" },
    });
    // Resending is answered with the same refusal, and the server stops there.
    const blocked = await sync(c, { commands: [late, next] }, afterExpiry);
    expect(blocked.payload.acknowledgements).toEqual([
      expect.objectContaining({
        sequence: 2,
        status: "rejected",
        error: expect.objectContaining({ code: "GRANT_EXPIRED" }),
      }),
    ]);

    // Review: the entry decoded, why it was refused, and whether it can be recorded as it happened.
    const [listed] = await reviews.list(c.fx.tenantId, branch(c));
    expect(listed).toMatchObject({
      state: "open",
      kind: "ordinary_sale",
      sequence: 2,
      totalMinor: late.payload.totalMinor,
      attempts: 2,
      refusal: {
        code: "GRANT_EXPIRED",
        explanation: expect.stringContaining("24-hour"),
      },
    });
    const reviewId = listed!.id;
    const detail = await reviews.detail(c.fx.tenantId, branch(c), reviewId);
    expect(detail).toMatchObject({
      state: "open",
      acceptedThroughSequence: 1,
      settleBlocker: null,
      recordable: { ok: true, blocker: null },
      entry: {
        kind: "ordinary_sale",
        staff: { id: c.cashier.userId },
        workSessionId,
        payments: [
          expect.objectContaining({
            method: "cash",
            amountMinor: late.payload.totalMinor,
          }),
        ],
      },
    });
    expect(
      detail.entry.kind === "ordinary_sale" && detail.entry.lines[0],
    ).toMatchObject({
      product: { id: c.fx.productId },
      batch: { id: c.batches.late },
      quantity: 2,
      unitPriceMinor: 1550,
      inSnapshot: true,
    });

    // A cashier can't decide; a reason is required.
    await expect(
      reviews.prepare(c.cashier, branch(c), reviewId, {
        decision: "recorded",
        reason: "x",
      }),
    ).rejects.toThrow(/can't review/);
    await expect(
      reviews.prepare(c.manager, branch(c), reviewId, {
        decision: "recorded",
        reason: "  ",
      }),
    ).rejects.toThrow("Say why");

    // Owners only may approve their own requests here: the manager prepares, the owner approves.
    await selfApproval(c, ["owner"]);
    const prepared = await reviews.prepare(c.manager, branch(c), reviewId, {
      decision: "recorded",
      reason: "Power cut ran past midnight; the customer paid cash for these",
    });
    expect(prepared).toMatchObject({
      status: "prepared",
      decision: "recorded",
      requester: { id: c.manager.userId },
    });
    await expect(
      reviews.prepare(c.manager, branch(c), reviewId, {
        decision: "not_honoured",
        reason: "Changed my mind",
      }),
    ).rejects.toThrow(/already waiting/);
    const review = prepared.approvalReview!;
    await expect(
      reviews.approve(c.manager, branch(c), prepared.id, {
        approvalId: randomUUID(),
        ...review,
      }),
    ).rejects.toThrow("can't approve its own requests");
    await expect(
      reviews.approve(c.owner, branch(c), prepared.id, {
        approvalId: randomUUID(),
        ...review,
        expectedDigest: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ response: { code: "APPROVAL_STALE" } });
    const approvalId = randomUUID();
    const settled = await reviews.approve(c.owner, branch(c), prepared.id, {
      approvalId,
      ...review,
    });
    expect(settled).toMatchObject({
      status: "settled",
      approver: { id: c.owner.userId },
      executionApprovalId: approvalId,
      sale: { id: expect.any(String), stockCaseId: expect.any(String) },
    });
    // A retried approval answers with the settlement; another is refused.
    expect(
      await reviews.approve(c.owner, branch(c), prepared.id, {
        approvalId,
        ...review,
      }),
    ).toMatchObject({ status: "settled" });
    await expect(
      reviews.approve(c.owner, branch(c), prepared.id, {
        approvalId: randomUUID(),
        ...review,
      }),
    ).rejects.toThrow(/no longer waiting/);

    // The sale as the counter made it: its prices, payment, seller and shift. No stock moved.
    const sale = await prisma.sale.findFirstOrThrow({
      where: {
        tenantId: c.fx.tenantId,
        offlineCommandId: late.payload.commandId,
      },
      include: { payments: true },
    });
    expect(sale).toMatchObject({
      id: settled.sale!.id,
      stockPosting: "pending_reconciliation",
      soldBy: c.cashier.userId,
      shiftId: workSessionId,
    });
    expect(sale.grandTotal.mul(100).toNumber()).toBe(late.payload.totalMinor);
    expect(sale.soldAt.getTime()).toBeLessThanOrEqual(late.payload.occurredAt);
    expect(sale.payments.map((p) => [p.method, p.shiftId])).toEqual([
      ["cash", workSessionId],
    ]);
    expect(await onHand(c.batches.late)).toBe(10);
    const discrepancy = await prisma.offlineStockDiscrepancy.findUniqueOrThrow({
      where: { id: settled.sale!.stockCaseId! },
      include: { lines: true, blocks: true },
    });
    expect(discrepancy).toMatchObject({ status: "open", saleId: sale.id });
    expect(
      discrepancy.lines.map((l) => [l.batchId, l.reason, l.shortfallQuantity]),
    ).toEqual([[c.batches.late, "entry_reviewed", 0]]);
    expect(discrepancy.blocks.map((b) => [b.batchId, b.releasedAt])).toEqual([
      [c.batches.late, null],
    ]);
    // The server's receipt sits at the entry's own sequence with its own digest.
    expect(
      await prisma.terminalCommandReceipt.findFirstOrThrow({
        where: {
          tenantId: c.fx.tenantId,
          enrollmentId: c.identity.enrollmentId,
          offlineSequence: 2n,
        },
      }),
    ).toMatchObject({
      commandId: late.payload.commandId,
      requestDigest: sha256(commandText(late.payload)),
      actorUserId: c.owner.userId,
    });
    expect(
      await prisma.auditEvent.findFirst({
        where: {
          tenantId: c.fx.tenantId,
          eventName: "offline_journal_settlement.settled",
          entityId: prepared.id,
        },
      }),
    ).toMatchObject({
      actorUserId: c.owner.userId,
      payload: expect.objectContaining({
        decision: "recorded",
        refusalCode: "GRANT_EXPIRED",
      }),
    });

    // The counter resends: the signed response says how it was settled, and the next entry chains on.
    const resent = await sync(c, { commands: [late, next] }, afterExpiry + 1);
    expect(
      verify(
        null,
        Buffer.from(terminalSigningText("sync_response", resent.payload)),
        server.publicKey,
        Buffer.from(resent.signature, "base64url"),
      ),
    ).toBe(true);
    expect(resent.payload.acknowledgements[0]).toEqual({
      commandId: late.payload.commandId,
      commandHash: sha256(commandText(late.payload)),
      sequence: 2,
      status: "reviewed",
      committedAt: expect.any(Number),
      commandKind: "ordinary_sale",
      decision: "recorded",
      saleId: sale.id,
      stockPosting: "pending_reconciliation",
      reconciliationCaseId: discrepancy.id,
      review: {
        settlementId: prepared.id,
        refusalCode: "GRANT_EXPIRED",
        settledAt: expect.any(Number),
      },
    });
    expect(resent.payload.acknowledgements[1]).toMatchObject({
      sequence: 3,
      status: "committed",
      stockPosting: "posted",
    });
    expect(resent.payload.committedThroughSequence).toBe(3);
    expect(await onHand(c.batches.other)).toBe(9);
    // Once more: the same answer (a lost response is harmless).
    expect(
      statuses(
        (await sync(c, { commands: [late, next] }, afterExpiry + 2)).payload
          .acknowledgements,
      ),
    ).toEqual(["reviewed", "duplicate"]);

    // Unstuck: the counter's next authority rebases past it, the recorded sale's batch held.
    const state = await stuck(c);
    expect(state).toMatchObject({
      includedThroughSequence: 3,
      includedThroughHash: sha256(commandText(next.payload)),
    });
    expect([...state.reviewRequiredBatchIds]).toEqual([c.batches.late]);
    expect(await reviews.list(c.fx.tenantId, branch(c))).toEqual([]);
    expect(await reviews.list(c.fx.tenantId, branch(c), "closed")).toEqual([
      expect.objectContaining({ id: reviewId, state: "settled" }),
    ]);
    expect(
      await reviews.detail(c.fx.tenantId, branch(c), reviewId),
    ).toMatchObject({ state: "settled", settleBlocker: { code: "settled" } });
  });

  it("not honoured: no sale, payment or stock; the cash the counter took shows as the shift's variance", async () => {
    const c = await counter({ main: 2 });
    const j = offlineJournal(c);
    const workSessionId = randomUUID();
    const cashierIn = j.signIn(c.cashier.userId, workSessionId);
    const open = j.open(cashierIn, 1_000);
    const over = j.sale(cashierIn, [[c.batches.main, 3]]);
    const taken = over.payload.totalMinor;
    const close = j.close(cashierIn, 1_000 + taken, 1_000 + taken);

    const first = await sync(c, {
      staffSignIns: [cashierIn],
      commands: [open, over, close],
    });
    expect(statuses(first.payload.acknowledgements)).toEqual([
      "committed",
      "rejected",
    ]);
    expect(first.payload.acknowledgements[1]).toMatchObject({
      error: { code: "LOCAL_STOCK_EXHAUSTED" },
    });

    // A manager may approve their own decisions (the default), so preparing settles it.
    const reviewId = await reviewOf(c, over.payload.commandId);
    const settled = await reviews.prepare(c.manager, branch(c), reviewId, {
      decision: "not_honoured",
      reason:
        "Sold stock we didn't have; customer refunded in cash at the till",
    });
    expect(settled).toMatchObject({
      status: "settled",
      decision: "not_honoured",
      requester: { id: c.manager.userId },
      approver: { id: c.manager.userId },
      sale: null,
    });

    const resent = await sync(c, { commands: [over, close] });
    expect(resent.payload.acknowledgements[0]).toMatchObject({
      status: "reviewed",
      commandKind: "ordinary_sale",
      decision: "not_honoured",
      review: { refusalCode: "LOCAL_STOCK_EXHAUSTED" },
    });
    expect(resent.payload.acknowledgements[0]).not.toHaveProperty("saleId");
    expect(resent.payload.acknowledgements[1]).toMatchObject({
      status: "committed",
      commandKind: "shift_close",
    });
    expect(
      await prisma.sale.count({ where: { tenantId: c.fx.tenantId } }),
    ).toBe(0);
    expect(
      await prisma.offlineStockDiscrepancy.count({
        where: { tenantId: c.fx.tenantId },
      }),
    ).toBe(0);
    expect(await onHand(c.batches.main)).toBe(2);
    expect(
      await prisma.tillShift.findUniqueOrThrow({
        where: { id: workSessionId },
      }),
    ).toMatchObject({
      expectedCashMinor: 1_000,
      counterExpectedCashMinor: 1_000 + taken,
      closingCashCountMinor: 1_000 + taken,
      varianceMinor: taken,
    });
    await expect(stuck(c)).resolves.toMatchObject({
      includedThroughSequence: 3,
    });
  });

  it("can't record figures that don't add up or a shift the till won't take; a revoked counter is recovered, not settled", async () => {
    const c = await counter({ main: 10 });
    const j = offlineJournal(c);
    const aIn = j.signIn(c.cashier.userId, randomUUID());
    const open = j.open(aIn, 0);
    const sale = j.sale(aIn, [[c.batches.main, 1]]);
    const cheaper = j.tamper(sale, {
      lines: [{ ...sale.payload.lines[0]!, unitPriceMinor: 1 }],
    });
    const first = await sync(c, {
      staffSignIns: [aIn],
      commands: [open, cheaper],
    });
    expect(first.payload.acknowledgements[1]).toMatchObject({
      status: "rejected",
      error: { code: "INVALID_COMMAND" },
    });
    const repriced = await reviewOf(c, cheaper.payload.commandId);
    expect(
      (await reviews.detail(c.fx.tenantId, branch(c), repriced)).recordable,
    ).toMatchObject({ ok: false, blocker: "prices_differ" });
    await expect(
      reviews.prepare(c.manager, branch(c), repriced, {
        decision: "recorded",
        reason: "Discount the owner gave",
      }),
    ).rejects.toThrow(/can't be recorded as it happened/);
    await reviews.prepare(c.manager, branch(c), repriced, {
      decision: "not_honoured",
      reason: "Price was keyed wrongly",
    });

    // A second shift opened on a till that already has one open: never recorded, only not honoured.
    const other = randomUUID();
    const bIn = j.signIn(c.manager.userId, other);
    const openB = j.tamper(j.open(bIn, 0), {
      previousCommandHash: sha256(commandText(cheaper.payload)),
    });
    const second = await sync(c, { staffSignIns: [bIn], commands: [openB] });
    expect(second.payload.acknowledgements[0]).toMatchObject({
      sequence: 3,
      status: "rejected",
    });
    const shiftReview = await reviewOf(c, openB.payload.commandId);
    expect(
      await reviews.detail(c.fx.tenantId, branch(c), shiftReview),
    ).toMatchObject({
      recordable: { ok: false, blocker: "till_has_open_shift" },
      // It may be not honoured, and the page says what that leaves behind and how to avoid it.
      notHonoured: {
        ok: true,
        message: expect.stringContaining(
          "close the shift still open on this till first",
        ),
      },
    });

    // Once the counter is revoked, its journal goes to journal recovery instead.
    await prisma.$transaction((tx) =>
      trust.revokeEnrollment(
        tx,
        c.owner,
        branch(c),
        c.identity.enrollmentId,
        "Stolen",
      ),
    );
    expect(
      (await reviews.detail(c.fx.tenantId, branch(c), shiftReview))
        .settleBlocker,
    ).toMatchObject({ code: "counter_revoked" });
    await expect(
      reviews.prepare(c.owner, branch(c), shiftReview, {
        decision: "not_honoured",
        reason: "Duplicate shift",
      }),
    ).rejects.toThrow(/revoked or retired/);
    expect(
      await prisma.tillShift.count({ where: { tenantId: c.fx.tenantId } }),
    ).toBe(1);
  });

  it("a shift opened on a clock ahead of the server: recorded, dated when it arrived, and the next entry isn't judged by that clock", async () => {
    const c = await counter({ main: 10 });
    const j = offlineJournal(c);
    const workSessionId = randomUUID();
    const cashierIn = j.signIn(c.cashier.userId, workSessionId);
    const ahead = j.open(cashierIn, 2_000, null, {
      occurredAt: Date.now() + 2 * hour,
    });
    const sale = j.sale(cashierIn, [[c.batches.main, 1]]);
    const first = await sync(c, {
      staffSignIns: [cashierIn],
      commands: [ahead, sale],
    });
    expect(
      first.payload.acknowledgements.map((a) => [
        a.status,
        "error" in a ? a.error.code : null,
      ]),
    ).toEqual([["rejected", "CLOCK_UNTRUSTED"]]);

    const reviewId = await reviewOf(c, ahead.payload.commandId);
    const received = (
      await prisma.offlineJournalReview.findUniqueOrThrow({
        where: { id: reviewId },
      })
    ).firstReceivedAt;
    expect(
      (await reviews.detail(c.fx.tenantId, branch(c), reviewId)).recordable,
    ).toMatchObject({ ok: true });
    const settled = await reviews.prepare(c.manager, branch(c), reviewId, {
      decision: "recorded",
      reason: "Counter clock was wrong; shift did open",
    });
    expect(settled).toMatchObject({ status: "settled", workSessionId });
    const shift = await prisma.tillShift.findUniqueOrThrow({
      where: { id: workSessionId },
    });
    expect(shift).toMatchObject({
      openCommandId: ahead.payload.commandId,
      openingCashMinor: 2_000,
      closedAt: null,
    });
    expect(shift.openedAt.getTime()).toBe(received.getTime());

    // The sale's time is earlier than the refused entry's, but the floor is the last entry accepted on its own.
    const resent = await sync(c, { commands: [ahead, sale] });
    expect(resent.payload.acknowledgements[0]).toMatchObject({
      status: "reviewed",
      commandKind: "shift_open",
      decision: "recorded",
      workSessionId,
      review: { refusalCode: "CLOCK_UNTRUSTED" },
    });
    expect(resent.payload.acknowledgements[1]).toMatchObject({
      status: "committed",
      stockPosting: "posted",
    });
    expect(await onHand(c.batches.main)).toBe(9);
  });

  it("concurrent approvals settle once; a cancelled decision can't be approved", async () => {
    const c = await counter({ main: 10 });
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    // Entry 1 is the refused sale; the open of the shift it names (entry 2) waits behind it.
    const late = j.sale(cashierIn, [[c.batches.main, 1]], {
      occurredAt: c.grant.expiresAt,
    });
    const open = j.open(cashierIn, 0);
    const first = await sync(
      c,
      { staffSignIns: [cashierIn], commands: [open, late] },
      c.grant.expiresAt + hour,
    );
    expect(statuses(first.payload.acknowledgements)).toEqual(["rejected"]);
    const reviewId = await reviewOf(c, late.payload.commandId);
    // Its shift is not open on the server, so it can only be not honoured.
    expect(
      (await reviews.detail(c.fx.tenantId, branch(c), reviewId)).recordable,
    ).toMatchObject({ ok: false, blocker: "shift_not_open" });

    await selfApproval(c, ["owner"]);
    const cancelled = await reviews.prepare(c.manager, branch(c), reviewId, {
      decision: "not_honoured",
      reason: "First try",
    });
    expect(
      await reviews.cancel(c.manager, branch(c), cancelled.id),
    ).toMatchObject({
      status: "cancelled",
      cancelledBy: { id: c.manager.userId },
    });
    await expect(
      reviews.approve(c.owner, branch(c), cancelled.id, {
        approvalId: randomUUID(),
        ...cancelled.approvalReview!,
      }),
    ).rejects.toThrow(/no longer waiting/);

    const prepared = await reviews.prepare(c.manager, branch(c), reviewId, {
      decision: "not_honoured",
      reason: "Sold after the permission ran out",
    });
    const results = await Promise.allSettled(
      [1, 2, 3].map(() =>
        reviews.approve(c.owner, branch(c), prepared.id, {
          approvalId: randomUUID(),
          ...prepared.approvalReview!,
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      await prisma.terminalCommandReceipt.count({
        where: {
          tenantId: c.fx.tenantId,
          enrollmentId: c.identity.enrollmentId,
        },
      }),
    ).toBe(1);
    expect(
      await prisma.offlineJournalSettlement.count({
        where: { tenantId: c.fx.tenantId, status: "settled" },
      }),
    ).toBe(1);

    // The open now follows the settled entry and is accepted.
    const resent = await sync(
      c,
      { commands: [late, open] },
      c.grant.expiresAt + hour,
    );
    expect(statuses(resent.payload.acknowledgements)).toEqual([
      "reviewed",
      "committed",
    ]);
  });

  it("an entry held for its sign-in, then rejected once judged, is listed, settled and answered from the record", async () => {
    const c = await counter({ main: 10 });
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    // No shift was opened. Without its sign-in the sale waits for it, and isn't a refusal yet.
    const sale = j.sale(cashierIn, [[c.batches.main, 1]]);
    expect(
      (await sync(c, { commands: [sale] })).payload.acknowledgements[0],
    ).toMatchObject({ status: "held", error: { code: "SESSION_INVALID" } });
    expect(await reviews.list(c.fx.tenantId, branch(c))).toEqual([]);

    // With the sign-in it is judged and refused for good (no shift is open to sell on).
    expect(
      (await sync(c, { staffSignIns: [cashierIn], commands: [sale] })).payload
        .acknowledgements[0],
    ).toMatchObject({ status: "rejected", error: { code: "SESSION_INVALID" } });
    // Final: a resend is answered from the record, not judged again.
    expect(
      (await sync(c, { commands: [sale] })).payload.acknowledgements[0],
    ).toMatchObject({ status: "rejected", error: { code: "SESSION_INVALID" } });
    const [listed] = await reviews.list(c.fx.tenantId, branch(c));
    expect(listed).toMatchObject({ state: "open", sequence: 1, attempts: 3 });
    expect(
      await reviews.detail(c.fx.tenantId, branch(c), listed!.id),
    ).toMatchObject({
      settleBlocker: null,
      recordable: { ok: false, blocker: "shift_not_open" },
      notHonoured: { ok: true },
    });

    expect(
      await reviews.prepare(c.manager, branch(c), listed!.id, {
        decision: "not_honoured",
        reason: "Sold with no shift open",
      }),
    ).toMatchObject({ status: "settled", decision: "not_honoured" });
    expect(
      (await sync(c, { commands: [sale] })).payload.acknowledgements[0],
    ).toMatchObject({ status: "reviewed", decision: "not_honoured" });
    await expect(stuck(c)).resolves.toMatchObject({
      includedThroughSequence: 1,
    });
  });

  it("a card sale not honoured keeps its card money as collected, not sold", async () => {
    const c = await counter({ main: 10 });
    const j = offlineJournal(c);
    const workSessionId = randomUUID();
    const cashierIn = j.signIn(c.cashier.userId, workSessionId);
    const open = j.open(cashierIn, 0);
    const known = c.snapshot.lines.find((l) => l.batchId === c.batches.main)!;
    const total =
      known.unitPriceMinor +
      Number(
        (BigInt(known.unitPriceMinor) * BigInt(known.taxBasisPoints) + 5000n) /
          10000n,
      );
    const late = j.sale(cashierIn, [[c.batches.main, 1]], {
      occurredAt: c.grant.expiresAt,
      payments: [
        {
          method: "external_card",
          amountMinor: total,
          providerReference: "TID-42 RRN-0001",
          approvalCode: "A1B2C3",
          approvedAt: c.grant.expiresAt,
        },
      ],
    });
    const after = c.grant.expiresAt + hour;
    const first = await sync(
      c,
      { staffSignIns: [cashierIn], commands: [open, late] },
      after,
    );
    expect(statuses(first.payload.acknowledgements)).toEqual([
      "committed",
      "rejected",
    ]);
    const reviewId = await reviewOf(c, late.payload.commandId);
    expect(
      (await reviews.detail(c.fx.tenantId, branch(c), reviewId)).notHonoured,
    ).toEqual({
      ok: true,
      message: expect.stringContaining("kept as collected, not sold"),
    });

    const settled = await reviews.prepare(c.manager, branch(c), reviewId, {
      decision: "not_honoured",
      reason: "Customer came back; refund the card at the counter",
    });
    expect(settled).toMatchObject({
      status: "settled",
      sale: null,
      collectedPayments: [
        {
          method: "external_card",
          amountMinor: total,
          providerReference: "TID-42 RRN-0001",
          approvalCode: "A1B2C3",
          shiftId: workSessionId,
        },
      ],
    });
    // No sale or payment, but the money is findable: on the record, in the settled list, by shift.
    expect(
      await prisma.sale.count({ where: { tenantId: c.fx.tenantId } }),
    ).toBe(0);
    expect(await reviews.list(c.fx.tenantId, branch(c), "closed")).toEqual([
      expect.objectContaining({ id: reviewId, collectedNotSoldMinor: total }),
    ]);
    const kept = await prisma.offlineCollectedPayment.findFirstOrThrow({
      where: { tenantId: c.fx.tenantId, shiftId: workSessionId },
    });
    expect(kept).toMatchObject({
      settlementId: settled.id,
      commandId: late.payload.commandId,
      staffUserId: c.cashier.userId,
      amountMinor: BigInt(total),
    });
    // Kept as it was collected.
    await expect(
      prisma.offlineCollectedPayment.update({
        where: { id: kept.id },
        data: { amountMinor: 1n },
      }),
    ).rejects.toThrow(/kept as they were collected/);
    expect(
      (await sync(c, { commands: [late] }, after)).payload.acknowledgements[0],
    ).toMatchObject({ status: "reviewed", decision: "not_honoured" });
  });

  it("a shift record the till can take is recorded, never not honoured: a close after the permission ran out", async () => {
    const c = await counter({ main: 10 });
    const j = offlineJournal(c);
    const workSessionId = randomUUID();
    const cashierIn = j.signIn(c.cashier.userId, workSessionId);
    const open = j.open(cashierIn, 500);
    const sale = j.sale(cashierIn, [[c.batches.main, 1]]);
    const taken = sale.payload.totalMinor;
    const close = j.tamper(j.close(cashierIn, 500 + taken + 100, 500 + taken), {
      occurredAt: c.grant.expiresAt,
    });
    const after = c.grant.expiresAt + hour;
    const first = await sync(
      c,
      { staffSignIns: [cashierIn], commands: [open, sale, close] },
      after,
    );
    expect(statuses(first.payload.acknowledgements)).toEqual([
      "committed",
      "committed",
      "rejected",
    ]);
    const reviewId = await reviewOf(c, close.payload.commandId);
    expect(
      await reviews.detail(c.fx.tenantId, branch(c), reviewId),
    ).toMatchObject({
      recordable: { ok: true },
      notHonoured: {
        ok: false,
        message: expect.stringContaining("can take this shift record"),
      },
    });
    await expect(
      reviews.prepare(c.manager, branch(c), reviewId, {
        decision: "not_honoured",
        reason: "Closed too late",
      }),
    ).rejects.toThrow(/can take this shift record/);

    const settled = await reviews.prepare(c.manager, branch(c), reviewId, {
      decision: "recorded",
      reason: "Cashier closed after the permission ran out",
    });
    expect(settled).toMatchObject({ status: "settled", workSessionId });
    const shift = await prisma.tillShift.findUniqueOrThrow({
      where: { id: workSessionId },
    });
    expect(shift).toMatchObject({
      closeCommandId: close.payload.commandId,
      closingCashCountMinor: 500 + taken + 100,
      expectedCashMinor: 500 + taken,
      counterExpectedCashMinor: 500 + taken,
      varianceMinor: 100,
    });
    expect(shift.closedAt!.getTime()).toBeGreaterThanOrEqual(
      shift.openedAt.getTime(),
    );
    expect(
      (await sync(c, { commands: [close] }, after)).payload.acknowledgements[0],
    ).toMatchObject({
      status: "reviewed",
      commandKind: "shift_close",
      decision: "recorded",
      workSessionId,
    });
  });

  it("a sale is recorded only on its seller's own shift, with their own sign-in", async () => {
    const c = await counter({ main: 10 });
    const j = offlineJournal(c);
    const shiftA = randomUUID();
    const cashierIn = j.signIn(c.cashier.userId, shiftA);
    const managerIn = j.signIn(c.manager.userId, shiftA);
    const open = j.open(cashierIn, 0);
    // The manager sells on the cashier's shift: intake refuses it, and so does recording.
    const onTheirs = j.sale(managerIn, [[c.batches.main, 1]]);
    // Then a sale naming the manager but citing the cashier's sign-in.
    const forged = j.sale(cashierIn, [[c.batches.main, 1]], {
      session: { ...cashierIn.payload.session, staffUserId: c.manager.userId },
    });
    const first = await sync(c, {
      staffSignIns: [cashierIn, managerIn],
      commands: [open, onTheirs],
    });
    expect(first.payload.acknowledgements[1]).toMatchObject({
      status: "rejected",
      error: { code: "SESSION_INVALID" },
    });
    const theirs = await reviewOf(c, onTheirs.payload.commandId);
    expect(
      (await reviews.detail(c.fx.tenantId, branch(c), theirs)).recordable,
    ).toMatchObject({ ok: false, blocker: "shift_not_theirs" });
    await expect(
      reviews.prepare(c.manager, branch(c), theirs, {
        decision: "recorded",
        reason: "Cash is in that drawer",
      }),
    ).rejects.toThrow(/can't be recorded as it happened/);
    await reviews.prepare(c.manager, branch(c), theirs, {
      decision: "not_honoured",
      reason: "Sold on someone else's shift",
    });

    const next = await sync(c, { commands: [onTheirs, forged] });
    expect(statuses(next.payload.acknowledgements)).toEqual([
      "reviewed",
      "rejected",
    ]);
    expect(
      (
        await reviews.detail(
          c.fx.tenantId,
          branch(c),
          await reviewOf(c, forged.payload.commandId),
        )
      ).recordable,
    ).toMatchObject({ ok: false, blocker: "sign_in_mismatch" });
    expect(
      await prisma.sale.count({ where: { tenantId: c.fx.tenantId } }),
    ).toBe(0);
  });

  it("a forked journal, two records at one place, goes to journal recovery", async () => {
    const c = await counter({ main: 10 });
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    const open = j.open(cashierIn, 0);
    const late = j.sale(cashierIn, [[c.batches.main, 1]], {
      occurredAt: c.grant.expiresAt,
    });
    const after = c.grant.expiresAt + hour;
    await sync(c, { staffSignIns: [cashierIn], commands: [open, late] }, after);
    // A restored backup signs a different record at the same place, refused too.
    const other = j.tamper(late, {
      commandId: randomUUID(),
      lines: [{ ...late.payload.lines[0]!, quantity: 2 }],
    });
    expect(
      (await sync(c, { commands: [other] }, after)).payload.acknowledgements[0],
    ).toMatchObject({ sequence: 2, status: "rejected" });
    const reviewId = await reviewOf(c, late.payload.commandId);
    expect(
      (await reviews.detail(c.fx.tenantId, branch(c), reviewId)).settleBlocker,
    ).toMatchObject({ code: "forked" });
    await expect(
      reviews.prepare(c.manager, branch(c), reviewId, {
        decision: "not_honoured",
        reason: "Pick one",
      }),
    ).rejects.toThrow(/journal recovery/);
  });

  it("prepare with an Idempotency-Key answers a resend, even one racing the counter's", async () => {
    const c = await counter({ main: 10 });
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    const open = j.open(cashierIn, 0);
    const late = j.sale(cashierIn, [[c.batches.main, 1]], {
      occurredAt: c.grant.expiresAt,
    });
    const after = c.grant.expiresAt + hour;
    await sync(c, { staffSignIns: [cashierIn], commands: [open, late] }, after);
    const reviewId = await reviewOf(c, late.payload.commandId);
    const key = randomUUID();
    const body = {
      decision: "recorded",
      reason: "Paid in cash during the outage",
    };
    // Self-approved, so preparing writes the sale. The same request twice, and the counter's
    // resend of the entry, all at once.
    const [a, b, resent] = await Promise.all([
      reviews.prepare(c.manager, branch(c), reviewId, body, key),
      reviews.prepare(c.manager, branch(c), reviewId, body, key),
      sync(c, { commands: [late] }, after),
    ]);
    expect(a).toMatchObject({
      status: "settled",
      sale: { id: expect.any(String) },
    });
    expect(b.id).toBe(a.id);
    expect(["rejected", "reviewed"]).toContain(
      resent.payload.acknowledgements[0]!.status,
    );
    expect(
      await prisma.sale.count({ where: { tenantId: c.fx.tenantId } }),
    ).toBe(1);
    expect(
      await prisma.terminalCommandReceipt.count({
        where: { tenantId: c.fx.tenantId, offlineSequence: 2n },
      }),
    ).toBe(1);
    // Later: the same answer; the key with another decision is refused; no key is a conflict.
    expect(
      await reviews.prepare(c.manager, branch(c), reviewId, body, key),
    ).toMatchObject({ id: a.id, status: "settled" });
    await expect(
      reviews.prepare(
        c.manager,
        branch(c),
        reviewId,
        { ...body, decision: "not_honoured" },
        key,
      ),
    ).rejects.toThrow(/already used for a different decision/);
    await expect(
      reviews.prepare(c.manager, branch(c), reviewId, body),
    ).rejects.toThrow(/already settled/);
  });

  it("lists every blocking entry however many settled or overtaken ones are newer, and survives a broken clock", async () => {
    const c = await counter({ main: 10 });
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    const open = j.open(cashierIn, 0);
    // A clock that gives no date at all: refused, and still listed and settled.
    const broken = j.sale(cashierIn, [[c.batches.main, 1]], {
      occurredAt: 9e15,
    });
    const first = await sync(c, {
      staffSignIns: [cashierIn],
      commands: [open, broken],
    });
    expect(first.payload.acknowledgements[1]).toMatchObject({
      status: "rejected",
      error: { code: "CLOCK_UNTRUSTED" },
    });
    const reviewId = await reviewOf(c, broken.payload.commandId);
    const row = await prisma.offlineJournalReview.findUniqueOrThrow({
      where: { id: reviewId },
    });
    // 205 newer refusals the counter has long since moved past (at or before its head).
    const { envelope, ...rest } = row;
    const overtaken = Array.from({ length: 205 }, (_, i) => ({
      ...rest,
      id: randomUUID(),
      recordId: randomUUID(),
      recordHash: randomBytes(32).toString("hex"),
      sequence: 1n,
      envelope: envelope as Prisma.InputJsonValue,
      firstReceivedAt: new Date(Date.now() + 60_000 + i),
      lastReceivedAt: new Date(Date.now() + 60_000 + i),
    }));
    await prisma.offlineJournalReview.createMany({ data: overtaken });

    expect(await reviews.list(c.fx.tenantId, branch(c))).toEqual([
      expect.objectContaining({
        id: reviewId,
        state: "open",
        occurredAt: null,
      }),
    ]);
    expect(await reviews.list(c.fx.tenantId, branch(c), "closed")).toHaveLength(
      200,
    );
    const detail = await reviews.detail(c.fx.tenantId, branch(c), reviewId);
    expect(detail.entry).toMatchObject({ occurredAt: null });
    const settled = await reviews.prepare(c.manager, branch(c), reviewId, {
      decision: "recorded",
      reason: "The counter's clock was broken; the sale did happen",
    });
    expect(settled).toMatchObject({ status: "settled" });
    // Dated when the server first saw it.
    expect(
      (
        await prisma.sale.findFirstOrThrow({
          where: {
            tenantId: c.fx.tenantId,
            offlineCommandId: broken.payload.commandId,
          },
        })
      ).soldAt.getTime(),
    ).toBe(row.firstReceivedAt.getTime());
    expect(
      await reviews.detail(c.fx.tenantId, branch(c), reviewId),
    ).toMatchObject({ state: "settled" });
  });
});
