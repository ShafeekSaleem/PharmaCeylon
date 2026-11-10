import { randomUUID, verify } from "node:crypto";
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
      (await reviews.detail(c.fx.tenantId, branch(c), reviewId)).settleBlocker,
    ).toMatchObject({ code: "settled" });
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
      (await reviews.detail(c.fx.tenantId, branch(c), shiftReview)).recordable,
    ).toMatchObject({ ok: false, blocker: "till_has_open_shift" });

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
});
