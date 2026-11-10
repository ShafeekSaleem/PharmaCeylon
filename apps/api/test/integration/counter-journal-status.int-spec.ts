import { randomBytes, randomUUID } from "node:crypto";
import type { CounterJournalSyncView } from "@pharmaceylon/shared";
import { DailyWorkService } from "../../src/dashboard/daily-work.service";
import { CounterJournalStatusService } from "../../src/terminals/journal/counter-journal-status.service";
import {
  access,
  counter,
  journal,
  offlineJournal,
  prisma,
  request,
  sales,
  sync,
  trust,
  type Counter,
} from "./offline-counter.kit";

/**
 * P5 #51: what the Counters page and Daily work show of each counter's offline journal, read
 * from real receipts, retained refusals, sign-ins and stock cases in PostgreSQL.
 */
const status = new CounterJournalStatusService(prisma as never, access);

const mine = async (c: Counter): Promise<CounterJournalSyncView> => {
  const views = await status.list(c.manager, c.fx.mainBranchId);
  return views.find((v) => v.enrollmentId === c.identity.enrollmentId)!;
};

const journalWork = async (
  c: Counter,
  has: (key: string) => boolean = () => true,
) =>
  (
    await new DailyWorkService(
      prisma as never,
      { resolve: async () => ({ canSelfApprove: true, has }) } as never,
    ).get(c.manager, c.fx.mainBranchId, { filter: "all", page: 1 } as never, {
      pageSize: 200,
    })
  ).items.filter((item) => item.kind === "offline_journal.review");

afterAll(async () => {
  await prisma.$disconnect();
});

describe("counter journal sync status (P5 #51)", () => {
  it("follows the head and last upload, and counts a held entry as waiting until it is accepted", async () => {
    const c = await counter({ main: 20 });
    expect(await mine(c)).toMatchObject({
      current: true,
      head: null,
      lastUploadAt: null,
      waiting: 0,
      needsReview: 0,
      stuck: null,
      openStockCases: 0,
      terminalId: c.identity.terminalId,
      registerId: c.grant.registerId,
    });

    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    await sync(c, {
      staffSignIns: [cashierIn],
      commands: [
        j.open(cashierIn, 0),
        j.sale(cashierIn, [[c.batches.main, 1]]),
      ],
    });
    const head = await prisma.terminalCommandReceipt.findFirstOrThrow({
      where: {
        tenantId: c.fx.tenantId,
        enrollmentId: c.identity.enrollmentId,
        offlineSequence: 2n,
      },
    });
    const accepted = await mine(c);
    expect(accepted).toMatchObject({
      head: { sequence: 2, acceptedAt: head.recordedAt.getTime() },
      waiting: 0,
      needsReview: 0,
    });
    expect(accepted.lastUploadAt).toBeGreaterThanOrEqual(
      head.recordedAt.getTime(),
    );

    // A sale citing a sign-in the counter has not uploaded yet waits; the counter repairs it.
    const stranger = j.signIn(
      c.cashier.userId,
      cashierIn.payload.session.workSessionId,
    );
    const third = j.sale(stranger, [[c.batches.main, 1]]);
    await sync(c, { commands: [third] });
    const held = await mine(c);
    expect(held).toMatchObject({
      head: { sequence: 2 },
      waiting: 1,
      needsReview: 0,
      stuck: null,
    });
    const review = await prisma.offlineJournalReview.findFirstOrThrow({
      where: { tenantId: c.fx.tenantId, recordId: third.payload.commandId },
    });
    expect(held.lastUploadAt).toBe(review.lastReceivedAt.getTime());
    expect(await journalWork(c)).toEqual([]);

    // Sent again with its sign-in: accepted, and the retained refusal is behind the head now.
    await sync(c, { staffSignIns: [stranger], commands: [third] });
    expect(await mine(c)).toMatchObject({
      head: { sequence: 3 },
      waiting: 0,
      needsReview: 0,
      stuck: null,
    });
  });

  it("names the entry a journal stops on when it is rejected, and lists it in Daily work for counter managers", async () => {
    const c = await counter({ main: 20 });
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    await sync(c, {
      staffSignIns: [cashierIn],
      commands: [j.open(cashierIn, 0)],
    });
    const repriced = j.sale(cashierIn, [[c.batches.main, 1]]);
    const cheaper = j.tamper(repriced, {
      lines: [{ ...repriced.payload.lines[0]!, unitPriceMinor: 1 }],
    });
    await sync(c, { commands: [cheaper] });

    const view = await mine(c);
    const review = await prisma.offlineJournalReview.findFirstOrThrow({
      where: { tenantId: c.fx.tenantId, recordId: cheaper.payload.commandId },
    });
    expect(view).toMatchObject({
      head: { sequence: 1 },
      waiting: 0,
      needsReview: 1,
      stuck: {
        sequence: 2,
        outcome: "rejected",
        errorCode: "INVALID_COMMAND",
        since: review.firstReceivedAt.getTime(),
      },
    });

    const work = await journalWork(c);
    expect(work).toEqual([
      expect.objectContaining({
        id: `journal:${c.identity.enrollmentId}`,
        kind: "offline_journal.review",
        where: "web",
        category: "counter",
        title: "Offline sales stuck at a counter",
        detail: "Front · entry 2 was refused",
        reference: "PC",
        status: "rejected",
        href: "/settings/counters",
        approval: false,
        createdAt: review.firstReceivedAt.toISOString(),
      }),
    ]);
    // Only for whoever manages the counters.
    expect(await journalWork(c, (key) => key !== "tenant.management")).toEqual(
      [],
    );
  });

  it("counts a fork past the head as needing review, but not a conflict on an entry already accepted", async () => {
    const c = await counter({ main: 20 });
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    const open = j.open(cashierIn, 0);
    const sale = j.sale(cashierIn, [[c.batches.main, 2]]);
    await sync(c, { staffSignIns: [cashierIn], commands: [open, sale] });

    // Entry 2 again with other content: kept for review, but the server's entry 2 stands.
    await sync(c, {
      commands: [
        j.tamper(sale, { lines: [{ ...sale.payload.lines[0]!, quantity: 1 }] }),
      ],
    });
    expect(await mine(c)).toMatchObject({
      head: { sequence: 2 },
      needsReview: 0,
      waiting: 0,
      stuck: null,
    });
    expect(await journalWork(c)).toEqual([]);

    // Entry 3 doesn't follow the accepted chain: the journal stops there.
    const forked = j.sale(cashierIn, [[c.batches.main, 1]], {
      previousCommandHash: randomBytes(32).toString("hex"),
    });
    await sync(c, { commands: [forked] });
    expect(await mine(c)).toMatchObject({
      needsReview: 1,
      stuck: { sequence: 3, outcome: "conflict", errorCode: "REPLAY_CONFLICT" },
    });
    expect((await journalWork(c))[0]).toMatchObject({
      detail: "Front · entry 3 conflicts with the server's copy",
      status: "conflict",
    });
  });

  it("counts open stock cases from the counter's offline sales", async () => {
    const c = await counter({ partition: 10 });
    await sales.checkout(
      c.fx.tenantId,
      c.fx.mainBranchId,
      c.owner.userId,
      [],
      {
        items: [
          {
            productId: c.fx.productId,
            batchId: c.batches.partition,
            qty: 7,
            unitPrice: "15.50",
          },
        ],
      } as never,
      undefined,
    );
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    await sync(c, {
      staffSignIns: [cashierIn],
      commands: [
        j.open(cashierIn, 0),
        j.sale(cashierIn, [[c.batches.partition, 5]]),
      ],
    });
    // Accepted (the head moved), with its stock waiting on a case.
    expect(await mine(c)).toMatchObject({
      head: { sequence: 2 },
      waiting: 0,
      needsReview: 0,
      openStockCases: 1,
    });
  });

  it("keeps a revoked counter listed while its journal still has entries waiting, and only at its own branch", async () => {
    const c = await counter({ main: 20 });
    const other = await counter({ main: 5 });
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    const accepted = [
      j.open(cashierIn, 0),
      j.sale(cashierIn, [[c.batches.main, 1]]),
    ];
    await sync(c, { staffSignIns: [cashierIn], commands: accepted });
    await prisma.$transaction((tx) =>
      trust.revokeEnrollment(
        tx,
        c.owner,
        c.fx.mainBranchId,
        c.identity.enrollmentId,
        "Stolen",
      ),
    );

    // Revoked with nothing outstanding: history, not status.
    expect(await status.list(c.manager, c.fx.mainBranchId)).toEqual([]);

    await journal.sync(
      c.owner,
      c.fx.mainBranchId,
      request(c, {
        commands: [...accepted, j.sale(cashierIn, [[c.batches.main, 1]])],
      }),
    );
    const views = await status.list(c.manager, c.fx.mainBranchId);
    expect(views).toEqual([
      expect.objectContaining({
        enrollmentId: c.identity.enrollmentId,
        current: false,
        revokedAt: expect.any(Number),
        head: expect.objectContaining({ sequence: 2 }),
        waiting: 1,
        needsReview: 0,
      }),
    ]);
    // Another tenant's counter never appears, and its manager can't read this branch.
    expect(
      (await status.list(other.manager, other.fx.mainBranchId)).map(
        (v) => v.enrollmentId,
      ),
    ).toEqual([other.identity.enrollmentId]);
    await expect(
      status.list(other.manager, c.fx.mainBranchId),
    ).rejects.toThrow();
  });

  it("refuses someone who doesn't manage the counters", async () => {
    const c = await counter({ main: 5 });
    await expect(
      status.list(c.cashier, c.fx.mainBranchId),
    ).rejects.toMatchObject({ response: { code: "PERMISSION_DENIED" } });
  });
});
