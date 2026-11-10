import { randomBytes, randomUUID } from "node:crypto";
import { RoleName } from "@prisma/client";
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

const enrollments = async (c: Counter, branchId = c.fx.mainBranchId) =>
  (await status.list(c.manager, branchId)).enrollments;

const mine = async (c: Counter): Promise<CounterJournalSyncView> =>
  (await enrollments(c)).find(
    (v) => v.enrollmentId === c.identity.enrollmentId,
  )!;

const journalWork = async (
  c: Counter,
  has: (key: string) => boolean = () => true,
  branchId = c.fx.mainBranchId,
) =>
  (
    await new DailyWorkService(
      prisma as never,
      { resolve: async () => ({ canSelfApprove: true, has }) } as never,
    ).get(c.manager, branchId, { filter: "all", page: 1 } as never, {
      pageSize: 200,
    })
  ).items.filter((item) => item.kind === "offline_journal.review");

/** A computer enrolled at the tenant's other branch, with the same manager assigned there. */
async function otherBranchEnrollment(c: Counter) {
  const branchId = c.fx.otherBranchId;
  await prisma.userBranchRole.create({
    data: {
      tenantId: c.fx.tenantId,
      branchId,
      userId: c.manager.userId,
      role: RoleName.manager,
    },
  });
  const terminal = await prisma.operationalTerminal.create({
    data: { tenantId: c.fx.tenantId, branchId, label: "BACK-PC" },
  });
  return prisma.terminalEnrollment.create({
    data: {
      tenantId: c.fx.tenantId,
      branchId,
      terminalId: terminal.id,
      keyId: randomUUID(),
      publicKeyHex: "a".repeat(64),
      enrolledByUserId: c.owner.userId,
    },
  });
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe("counter journal sync status (P5 #51)", () => {
  it("follows the head and the last receipt, and stops at a held entry until it is accepted", async () => {
    const c = await counter({ main: 20 });
    expect((await status.list(c.manager, c.fx.mainBranchId)).timezone).toBe(
      "Asia/Colombo",
    );
    expect(await mine(c)).toMatchObject({
      current: true,
      head: null,
      lastReceivedAt: null,
      stoppedAt: null,
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
      stoppedAt: null,
    });
    expect(accepted.lastReceivedAt).toBeGreaterThanOrEqual(
      head.recordedAt.getTime(),
    );

    // A sale citing a sign-in the counter has not uploaded yet is held; the counter repairs it.
    const stranger = j.signIn(
      c.cashier.userId,
      cashierIn.payload.session.workSessionId,
    );
    const third = j.sale(stranger, [[c.batches.main, 1]]);
    await sync(c, { commands: [third] });
    const held = await mine(c);
    const review = await prisma.offlineJournalReview.findFirstOrThrow({
      where: { tenantId: c.fx.tenantId, recordId: third.payload.commandId },
    });
    expect(review.outcome).toBe("held");
    expect(held).toMatchObject({
      head: { sequence: 2 },
      stoppedAt: {
        sequence: 3,
        outcome: "held",
        errorCode: review.errorCode,
        since: review.firstReceivedAt.getTime(),
      },
    });
    expect(held.lastReceivedAt).toBe(review.lastReceivedAt.getTime());
    // Nothing for a manager to settle: the counter sends what the entry lacks.
    expect(await journalWork(c)).toEqual([]);

    // Sent again with its sign-in: accepted, and the retained refusal is behind the head now.
    await sync(c, { staffSignIns: [stranger], commands: [third] });
    expect(await mine(c)).toMatchObject({
      head: { sequence: 3 },
      stoppedAt: null,
    });
  });

  it("names the entry a journal stops on when it is rejected, and lists it in Daily work at its own branch only", async () => {
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
      stoppedAt: {
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
        title: "Review refused offline entry",
        detail: "Front · stopped at entry 2; nothing after it syncs",
        reference: "PC",
        status: "INVALID_COMMAND",
        href: "/settings/counters",
        approval: false,
        createdAt: review.firstReceivedAt.toISOString(),
      }),
    ]);
    // Only for whoever manages the counters.
    expect(await journalWork(c, (key) => key !== "tenant.management")).toEqual(
      [],
    );

    // The tenant's other branch, managed by the same manager, sees its own computer only.
    const back = await otherBranchEnrollment(c);
    expect(await enrollments(c, c.fx.otherBranchId)).toEqual([
      expect.objectContaining({
        enrollmentId: back.id,
        terminalLabel: "BACK-PC",
        head: null,
        stoppedAt: null,
      }),
    ]);
    expect(await journalWork(c, () => true, c.fx.otherBranchId)).toEqual([]);
    expect((await enrollments(c)).map((v) => v.enrollmentId)).toEqual([
      c.identity.enrollmentId,
    ]);
    expect(await journalWork(c)).toHaveLength(1);
  });

  it("stops at a fork past the head, not at a conflict on an entry already accepted, and leaves conflicts out of Daily work", async () => {
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
      stoppedAt: null,
    });
    expect(await journalWork(c)).toEqual([]);

    // Entry 3 doesn't follow the accepted chain: the journal stops there.
    const forked = j.sale(cashierIn, [[c.batches.main, 1]], {
      previousCommandHash: randomBytes(32).toString("hex"),
    });
    await sync(c, { commands: [forked] });
    expect(await mine(c)).toMatchObject({
      stoppedAt: {
        sequence: 3,
        outcome: "conflict",
        errorCode: "REPLAY_CONFLICT",
      },
    });
    // Slice 4 doesn't settle a conflict; D11 journal recovery (#154) does.
    expect(await journalWork(c)).toEqual([]);
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
      stoppedAt: null,
      openStockCases: 1,
    });
  });

  it("keeps a revoked counter listed while its journal stops short, and never shows another tenant's", async () => {
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
    expect(await status.list(c.manager, c.fx.mainBranchId)).toEqual({
      timezone: "Asia/Colombo",
      enrollments: [],
    });

    await journal.sync(
      c.owner,
      c.fx.mainBranchId,
      request(c, {
        commands: [...accepted, j.sale(cashierIn, [[c.batches.main, 1]])],
      }),
    );
    expect(await enrollments(c)).toEqual([
      expect.objectContaining({
        enrollmentId: c.identity.enrollmentId,
        current: false,
        revokedAt: expect.any(Number),
        head: expect.objectContaining({ sequence: 2 }),
        stoppedAt: expect.objectContaining({
          sequence: 3,
          outcome: "held",
          errorCode: "TERMINAL_REVOKED",
        }),
      }),
    ]);
    // A revoked key's journal waits for D11 recovery, not Daily work.
    expect(await journalWork(c)).toEqual([]);
    // Another tenant's counter never appears, and its manager can't read this branch.
    expect((await enrollments(other)).map((v) => v.enrollmentId)).toEqual([
      other.identity.enrollmentId,
    ]);
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
