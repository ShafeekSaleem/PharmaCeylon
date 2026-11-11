import { randomUUID } from "node:crypto";
import type {
  JournalPosition,
  OfflineCounterRestoreReport,
  OfflineJournalCommand,
  Signed,
} from "@pharmaceylon/shared";
import { OfflineCounterRestoreService } from "../../src/terminals/journal/counter-restore.service";
import { journalHash } from "../../src/terminals/journal/offline-journal-wire";
import {
  acceptedJournalState,
  issueOfflineAuthority,
} from "../../src/terminals/offline-authority-issuance";
import { terminalDevice } from "../fixtures/terminal-device";
import {
  access,
  assignments,
  audit,
  counter,
  offlineJournal,
  onHand,
  prisma,
  saleAck,
  signer,
  sync,
  type Counter,
} from "./offline-counter.kit";

/**
 * P5 #51, store backup and restore (decisions of 2026-11-10), against PostgreSQL: a counter
 * restored from an older backup while the server moved on. The server refuses it any offline
 * authority, old or new, until the owner or a delegated manager acknowledges the restore, and
 * tells it the latest version it issued so the counter never installs a superseded pair; and a
 * late sale over a count made after it waits on its case instead of deducting twice.
 */
const restores = new OfflineCounterRestoreService(
  prisma as never,
  access,
  audit,
  assignments,
);

afterAll(async () => {
  await prisma.$disconnect();
});

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: { response?: { code?: string } }) =>
      error.response?.code ?? String(error),
  );

const renew = (c: Counter, commandId: string = randomUUID()) =>
  issueOfflineAuthority(prisma as never, access, {
    signer,
    defaultVatRatePercent: 18,
    authenticate: async () => ({ identity: c.identity, commandId }),
    readState: acceptedJournalState,
  });

const position = (entry: Signed<OfflineJournalCommand>): JournalPosition => ({
  sequence: entry.payload.sequence,
  hash: journalHash(entry.payload),
});

function restoreReport(
  c: Counter,
  parts: Partial<OfflineCounterRestoreReport> = {},
) {
  const now = Date.now();
  return {
    contractVersion: 1,
    kind: "offline_counter_restore_report",
    restoreId: randomUUID(),
    identity: c.identity,
    reportedAt: now,
    backupId: "20261110T080000000Z-0123abcd",
    backupTakenAt: now - 3_600_000,
    restoredAt: now,
    journalHead: { sequence: 0, hash: null },
    acceptedWatermark: { sequence: 0, hash: null },
    outageActive: false,
    removedGrantVersion: 1,
    ...parts,
  } satisfies OfflineCounterRestoreReport;
}

describe("a counter restored from an older backup (P5 #51)", () => {
  it("gets no offline authority until the restore is acknowledged, and learns which pairs were superseded", async () => {
    const c = await counter({ main: 40 });
    // The backup was taken here: shift open, with pair v1 installed and a renewal request pending.
    const j = offlineJournal(c);
    const signIn = j.signIn(c.cashier.userId, randomUUID());
    const open = j.open(signIn, 100_000);
    const pendingAtBackup = randomUUID();
    // Then, before the store broke, the counter sold, uploaded and renewed twice.
    const sale = j.sale(signIn, [[c.batches.main, 2]]);
    const reply = await sync(c, {
      staffSignIns: [signIn],
      commands: [open, sale],
    });
    expect(reply.payload.committedThroughSequence).toBe(2);
    expect((await renew(c, pendingAtBackup)).grant.payload.grantVersion).toBe(
      2,
    );
    const latest = randomUUID();
    expect((await renew(c, latest)).grant.payload.grantVersion).toBe(3);

    // Before any restore, a lost response stays recoverable: each request replays its own version.
    expect((await renew(c, pendingAtBackup)).grant.payload.grantVersion).toBe(
      2,
    );
    expect((await renew(c, latest)).grant.payload.grantVersion).toBe(3);

    const sent = restoreReport(c, {
      journalHead: position(open),
      acceptedWatermark: { sequence: 0, hash: null },
      removedGrantVersion: 1,
    });
    const envelope = c.device.sign(sent, c.identity.keyId);
    const reported = await restores.report(c.cashier, c.fx.mainBranchId, {
      report: envelope,
    });
    expect(reported).toEqual({
      restoreId: sent.restoreId,
      status: "awaiting_acknowledgement",
      acknowledgedAt: null,
      latestGrantVersion: 3,
    });
    // Resending the same report is the same restore; other content under its ID is refused, and so
    // is a report another device signed.
    expect(
      await restores.report(c.cashier, c.fx.mainBranchId, { report: envelope }),
    ).toEqual(reported);
    expect(
      await code(
        restores.report(c.cashier, c.fx.mainBranchId, {
          report: c.device.sign(
            { ...sent, outageActive: true },
            c.identity.keyId,
          ),
        }),
      ),
    ).toBe("STORE_RESTORE_INVALID");
    expect(
      await code(
        restores.report(c.cashier, c.fx.mainBranchId, {
          report: terminalDevice().sign(restoreReport(c), c.identity.keyId),
        }),
      ),
    ).toBe("INVALID_SIGNATURE");
    expect(
      await code(
        restores.status(c.cashier, c.fx.mainBranchId, {
          identity: c.identity,
          restoreId: randomUUID(),
        }),
      ),
    ).toBe("resolved");
    expect(
      await restores.status(c.cashier, c.fx.mainBranchId, {
        identity: c.identity,
        restoreId: randomUUID(),
      }),
    ).toBeNull();

    // No authority while it waits: not a new pair, not even a replay of the request the backup
    // held or of the latest one.
    expect(await code(renew(c))).toBe("RECONCILIATION_REQUIRED");
    expect(await code(renew(c, pendingAtBackup))).toBe(
      "RECONCILIATION_REQUIRED",
    );
    expect(await code(renew(c, latest))).toBe("RECONCILIATION_REQUIRED");

    // The owner or a delegated manager acknowledges it, once, with a reason.
    const list = await restores.list(c.owner, c.fx.mainBranchId);
    expect(list.restores).toHaveLength(1);
    const [shown] = list.restores;
    expect(shown).toMatchObject({
      restoreId: sent.restoreId,
      status: "awaiting_acknowledgement",
      journalHead: position(open),
      serverHead: { sequence: 2, hash: reply.payload.committedThroughHash },
      outageActive: false,
      removedGrantVersion: 1,
      latestGrantVersion: 3,
      clockSkew: null,
      acknowledgement: null,
    });
    // The server last heard from the counter at its renewals, before the restore.
    expect(shown!.lastContactAt).not.toBeNull();
    expect(shown!.lastContactAt!).toBeLessThanOrEqual(sent.restoredAt);
    const reason = {
      reason:
        "Checked the drawer and the shelf against the uploaded sales; nothing missing.",
    };
    expect(
      await code(
        restores.acknowledge(c.cashier, c.fx.mainBranchId, shown!.id, reason),
      ),
    ).toBe("OFFLINE_ASSIGNMENT_NOT_DELEGATED");
    expect(
      await code(
        restores.acknowledge(c.manager, c.fx.mainBranchId, shown!.id, reason),
      ),
    ).toBe("OFFLINE_ASSIGNMENT_NOT_DELEGATED");
    await assignments.delegate(c.owner, c.fx.mainBranchId, c.manager.userId);
    const acknowledged = await restores.acknowledge(
      c.manager,
      c.fx.mainBranchId,
      shown!.id,
      reason,
    );
    expect(acknowledged).toMatchObject({
      status: "acknowledged",
      acknowledgement: {
        acknowledgedByUserId: c.manager.userId,
        authority: "delegated_manager",
        reason: reason.reason,
      },
    });
    expect(
      await code(
        restores.acknowledge(c.owner, c.fx.mainBranchId, shown!.id, reason),
      ),
    ).toBe("STORE_RESTORE_NOT_AWAITING");
    const status = await restores.status(c.cashier, c.fx.mainBranchId, {
      identity: c.identity,
      restoreId: sent.restoreId,
    });
    expect(status).toMatchObject({
      status: "acknowledged",
      latestGrantVersion: 3,
    });
    expect(status!.acknowledgedAt).toBe(
      acknowledged.acknowledgement!.acknowledgedAt,
    );

    // The next pair is a new version above that floor, rebased at the server's head. (The
    // desktop deleted the request the backup held; were it replayed, its v2 is at or below the
    // floor of 3 and the restored counter refuses to install it.)
    const fresh = await renew(c);
    expect(fresh.grant.payload.grantVersion).toBe(4);
    expect(fresh.grant.payload.grantVersion).toBeGreaterThan(
      status!.latestGrantVersion,
    );
    expect(fresh.snapshot.payload).toMatchObject({
      includedThroughSequence: 2,
      includedThroughHash: reply.payload.committedThroughHash,
    });
    expect(
      (await renew(c, pendingAtBackup)).grant.payload.grantVersion,
    ).toBeLessThanOrEqual(status!.latestGrantVersion);

    // The record is evidence: kept, and changed only by its acknowledgement.
    await expect(
      prisma.offlineCounterRestore.update({
        where: { id: shown!.id },
        data: { outageActive: true },
      }),
    ).rejects.toThrow(/keeps what was reported/);
    await expect(
      prisma.offlineCounterRestore.delete({ where: { id: shown!.id } }),
    ).rejects.toThrow(/retained/);
    const events = await prisma.auditEvent.findMany({
      where: { tenantId: c.fx.tenantId, entityId: shown!.id },
      orderBy: { createdAt: "asc" },
      select: { eventName: true },
    });
    expect(events.map((e) => e.eventName)).toEqual([
      "terminal.store_restore_reported",
      "terminal.store_restore_acknowledged",
    ]);
  });
});

describe("a counter whose clock is wrong (P5 #51)", () => {
  it("is still recorded, with the skew shown to the back office, and is acknowledged as usual", async () => {
    const c = await counter({ main: 5 });
    const now = Date.now();
    // A computer back from repair with a reset CMOS clock: it restored "in 2000" from a backup it
    // took an hour ago. Both times are its own clock, so the server records rather than refuses.
    const reset = restoreReport(c, {
      backupTakenAt: now - 3_600_000,
      restoredAt: Date.UTC(2000, 0, 1),
      reportedAt: Date.UTC(2000, 0, 1),
      removedGrantVersion: null,
    });
    expect(
      await restores.report(c.cashier, c.fx.mainBranchId, {
        report: c.device.sign(reset, c.identity.keyId),
      }),
    ).toMatchObject({
      restoreId: reset.restoreId,
      status: "awaiting_acknowledgement",
    });
    const [shown] = (await restores.list(c.owner, c.fx.mainBranchId)).restores;
    expect(shown).toMatchObject({
      restoreId: reset.restoreId,
      backupTakenAt: reset.backupTakenAt,
      restoredAt: reset.restoredAt,
      clockSkew: {
        backupAfterRestoreMs: reset.backupTakenAt - reset.restoredAt,
        aheadOfServerMs: 0,
      },
    });
    // Seen at report time, in the audit trail too.
    const reported = await prisma.auditEvent.findFirstOrThrow({
      where: {
        tenantId: c.fx.tenantId,
        entityId: shown!.id,
        eventName: "terminal.store_restore_reported",
      },
      select: { payload: true },
    });
    expect(reported.payload).toMatchObject({
      clockSkew: {
        backupAfterRestoreMs: reset.backupTakenAt - reset.restoredAt,
      },
    });

    // Still no offline authority until it is acknowledged, then as usual.
    expect(await code(renew(c))).toBe("RECONCILIATION_REQUIRED");
    await restores.acknowledge(c.owner, c.fx.mainBranchId, shown!.id, {
      reason:
        "Clock was reset; checked receipts against the server from the last upload.",
    });
    expect((await renew(c)).grant.payload.grantVersion).toBeGreaterThan(0);

    // A clock that runs fast instead dates the restore after the server received its report.
    const fast = restoreReport(c, {
      backupTakenAt: now - 60_000,
      restoredAt: now + 2 * 3_600_000,
      reportedAt: now + 2 * 3_600_000,
      removedGrantVersion: null,
    });
    await restores.report(c.cashier, c.fx.mainBranchId, {
      report: c.device.sign(fast, c.identity.keyId),
    });
    const ahead = (
      await restores.list(c.owner, c.fx.mainBranchId)
    ).restores.find((r) => r.restoreId === fast.restoreId);
    expect(ahead!.clockSkew!.backupAfterRestoreMs).toBe(0);
    expect(ahead!.clockSkew!.aheadOfServerMs).toBeGreaterThan(3_600_000);
  });
});

describe("a late offline sale over a count made after it (P5 #51)", () => {
  it("waits on its case instead of deducting the counted units twice", async () => {
    const c = await counter({ main: 10, other: 10 });
    const j = offlineJournal(c);
    const signIn = j.signIn(c.cashier.userId, randomUUID());
    const open = j.open(signIn, 100_000);
    const sale = j.sale(signIn, [
      [c.batches.main, 3],
      [c.batches.other, 1],
    ]);
    // The shop counted the main batch after the sale (the units already gone) and posted it.
    const countedAt = new Date(sale.payload.occurredAt + 60_000);
    const id = randomUUID();
    await prisma.stocktake.create({
      data: {
        id,
        tenantId: c.fx.tenantId,
        branchId: c.fx.mainBranchId,
        stocktakeNumber: `ST-${id.slice(0, 6)}`,
        status: "approved",
        countedBy: c.manager.userId,
        lines: {
          create: {
            tenantId: c.fx.tenantId,
            productId: c.fx.productId,
            batchId: c.batches.main,
            systemQty: 10,
            countedQty: 7,
            varianceQty: -3,
            status: "posted",
            countedAt,
            postedAt: countedAt,
          },
        },
      },
    });
    await prisma.stocktake.update({
      where: { id },
      data: {
        status: "completed",
        postedAt: countedAt,
        completedAt: countedAt,
      },
    });

    // The counter reconnects later (after a restore, say) and uploads the sale.
    const reply = await sync(c, {
      staffSignIns: [signIn],
      commands: [open, sale],
    });
    const ack = saleAck(
      reply.payload.acknowledgements.find(
        (a) => a.commandId === sale.payload.commandId,
      )!,
    );
    expect(ack.stockPosting).toBe("pending_reconciliation");
    const lines = await prisma.offlineStockDiscrepancyLine.findMany({
      where: { tenantId: c.fx.tenantId, caseId: ack.reconciliationCaseId! },
      orderBy: { reason: "asc" },
      select: { batchId: true, reason: true, shortfallQuantity: true },
    });
    expect(lines).toEqual([
      {
        batchId: c.batches.main,
        reason: "counted_after_sale",
        shortfallQuantity: 0,
      },
      {
        batchId: c.batches.other,
        reason: "sale_pending",
        shortfallQuantity: 0,
      },
    ]);
    // Nothing was deducted again: the stocktake's correction is not in this test, so on hand is
    // still the opening stock.
    expect(await onHand(c.batches.main)).toBe(10);
    expect(await onHand(c.batches.other)).toBe(10);
  });
});
