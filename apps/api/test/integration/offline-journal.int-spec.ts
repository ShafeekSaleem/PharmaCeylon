import { randomBytes, randomUUID, verify } from "node:crypto";
import { RoleName, StockMovementType } from "@prisma/client";
import { terminalSigningText, type Signed } from "@pharmaceylon/shared";
import { acceptedJournalState, issueOfflineAuthority } from "../../src/terminals/offline-authority-issuance";
import { commandText, sha256 } from "../../src/terminals/terminal-wire";
import { terminalDevice } from "../fixtures/terminal-device";
import {
  prisma,
  access,
  trust,
  stock,
  sales,
  server,
  signer,
  journal,
  counter,
  offlineJournal,
  request,
  sync,
  saleAck,
  onHand,
} from "./offline-counter.kit";

/** P5 #51: the nominated counter's offline journal, uploaded and accepted against PostgreSQL. */

afterAll(async () => {
  await prisma.$disconnect();
});

describe("offline journal intake (P5 #51)", () => {
  it("replays shift open, sales and close once, and an identical retry returns the original receipts", async () => {
    const c = await counter({ main: 40 });
    const j = offlineJournal(c);
    const workSessionId = randomUUID();
    const cashierIn = j.signIn(c.cashier.userId, workSessionId);
    const open = j.open(cashierIn, 500_000);
    const saleA = j.sale(cashierIn, [[c.batches.main, 2]]);
    const saleB = j.sale(cashierIn, [[c.batches.main, 3]]);
    const cashTaken = saleA.payload.totalMinor + saleB.payload.totalMinor;
    const close = j.close(cashierIn, 500_000 + cashTaken - 100, 500_000 + cashTaken);
    const commands = [open, saleA, saleB, close];

    const response = await sync(c, { staffSignIns: [cashierIn], commands });

    // Signed by the server's key with purpose sync_response, for this exact counter.
    expect(response.keyId).toBe(signer.keyId);
    expect(verify(null, Buffer.from(terminalSigningText("sync_response", response.payload)), server.publicKey,
      Buffer.from(response.signature, "base64url"))).toBe(true);
    expect(response.payload.identity).toEqual(c.identity);
    const acks = response.payload.acknowledgements;
    expect(acks.map((a) => a.status)).toEqual(["committed", "committed", "committed", "committed"]);
    expect(response.payload.committedThroughSequence).toBe(4);
    expect(response.payload.committedThroughHash).toBe(sha256(commandText(close.payload)));
    expect(acks[0]).toMatchObject({ commandKind: "shift_open", workSessionId });
    expect(acks[3]).toMatchObject({ commandKind: "shift_close", workSessionId });

    const shift = await prisma.tillShift.findUniqueOrThrow({ where: { id: workSessionId } });
    expect(shift).toMatchObject({
      staffUserId: c.cashier.userId, openedStaffSessionId: null, openCommandId: open.payload.commandId,
      openedSignInId: cashierIn.payload.staffSignInId, openingCashMinor: 500_000, closeKind: "self",
      closedByUserId: c.cashier.userId, closeCommandId: close.payload.commandId,
      closingCashCountMinor: 500_000 + cashTaken - 100,
      // The server's own figure from the replayed sales (tendered less change), the counter's beside it.
      expectedCashMinor: 500_000 + cashTaken, counterExpectedCashMinor: 500_000 + cashTaken, varianceMinor: -100,
    });
    expect(shift.openedAt.getTime()).toBe(open.payload.occurredAt);
    expect(shift.closedAt!.getTime()).toBe(close.payload.occurredAt);

    const saleRows = await prisma.sale.findMany({
      where: { tenantId: c.fx.tenantId, offlineCommandId: { not: null } },
      include: { items: true, payments: true }, orderBy: { soldAt: "asc" },
    });
    expect(saleRows).toHaveLength(2);
    for (const [row, signed] of [[saleRows[0]!, saleA], [saleRows[1]!, saleB]] as const) {
      expect(row).toMatchObject({
        shiftId: workSessionId, soldBy: c.cashier.userId, terminalId: c.identity.terminalId,
        offlineCommandId: signed.payload.commandId, stockPosting: "posted", workSessionId: cashierIn.payload.staffSignInId,
      });
      expect(row.soldAt.getTime()).toBe(signed.payload.occurredAt);
      expect(row.grandTotal.mul(100).toNumber()).toBe(signed.payload.totalMinor);
      // Saved snapshot prices and tax (D6), not today's catalog.
      expect(row.items[0]!.unitPrice.toFixed(2)).toBe("15.50");
      expect(row.items[0]!.taxAmount.mul(100).toNumber()).toBe(signed.payload.lines[0]!.taxMinor);
      expect(row.payments.map((p) => [p.method, p.shiftId])).toEqual([["cash", workSessionId]]);
    }
    expect(await onHand(c.batches.main)).toBe(35);
    const receipts = await prisma.terminalCommandReceipt.findMany({
      where: { tenantId: c.fx.tenantId, enrollmentId: c.identity.enrollmentId }, orderBy: { offlineSequence: "asc" },
    });
    expect(receipts.map((r) => Number(r.offlineSequence))).toEqual([1, 2, 3, 4]);

    // The response was lost: the counter sends the same bytes again.
    const retry = await sync(c, { staffSignIns: [cashierIn], commands });
    expect(retry.payload.acknowledgements.map((a) => a.status)).toEqual(["duplicate", "duplicate", "duplicate", "duplicate"]);
    expect(saleAck(retry.payload.acknowledgements[1]!).saleId).toBe(saleAck(acks[1]!).saleId);
    expect(retry.payload.acknowledgements[1]!).toMatchObject({ committedAt: (acks[1] as { committedAt: number }).committedAt });
    expect(await prisma.sale.count({ where: { tenantId: c.fx.tenantId } })).toBe(2);
    expect(await onHand(c.batches.main)).toBe(35);
    expect(await prisma.tillShift.count({ where: { tenantId: c.fx.tenantId } })).toBe(1);
    expect(retry.payload.committedThroughSequence).toBe(4);

    // A lost acknowledgement never reopens the closed shift: a second close of it is refused.
    const again = j.close(cashierIn, 1, 1);
    const reclosed = await sync(c, { commands: [again] });
    expect(reclosed.payload.acknowledgements[0]).toMatchObject({ status: "rejected", error: { code: "SESSION_INVALID" } });
    expect((await prisma.tillShift.findUniqueOrThrow({ where: { id: workSessionId } })).closingCashCountMinor).toBe(500_000 + cashTaken - 100);
  });

  it("an assisted close names the manager who closed it, and the next shift follows it", async () => {
    const c = await counter({ main: 10 });
    const j = offlineJournal(c);
    const first = randomUUID();
    const cashierIn = j.signIn(c.cashier.userId, first);
    const managerIn = j.signIn(c.manager.userId, randomUUID());
    const open = j.open(cashierIn, 1_000);
    const sale = j.sale(cashierIn, [[c.batches.main, 1]]);
    const close = j.close(managerIn, 1_000 + sale.payload.totalMinor, 1_000 + sale.payload.totalMinor,
      { managerSignInId: managerIn.payload.staffSignInId, reason: "Cashier left sick" }, cashierIn);
    const second = randomUUID();
    const managerShiftIn = j.signIn(c.manager.userId, second);
    const reopen = j.open(managerShiftIn, 2_000, first);

    const response = await sync(c, { staffSignIns: [cashierIn, managerIn, managerShiftIn], commands: [open, sale, close, reopen] });
    expect(response.payload.acknowledgements.map((a) => a.status)).toEqual(["committed", "committed", "committed", "committed"]);
    expect(await prisma.tillShift.findUniqueOrThrow({ where: { id: first } })).toMatchObject({
      staffUserId: c.cashier.userId, closedByUserId: c.manager.userId, closeKind: "assisted",
      assistanceReason: "Cashier left sick", closedSignInId: managerIn.payload.staffSignInId, varianceMinor: 0,
    });
    expect(await prisma.tillShift.findUniqueOrThrow({ where: { id: second } })).toMatchObject({
      staffUserId: c.manager.userId, previousClosedWorkSessionId: first, closedAt: null, openingCashMinor: 2_000,
    });
  });

  it("accepts a reordered upload in sequence order, holds a gap, and keeps later entries queued", async () => {
    const c = await counter({ main: 20 });
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    const one = j.open(cashierIn, 0);
    const two = j.sale(cashierIn, [[c.batches.main, 1]]);
    const three = j.sale(cashierIn, [[c.batches.main, 1]]);
    const four = j.sale(cashierIn, [[c.batches.main, 1]]);

    // 3 and 1 arrive, out of order and without 2.
    const first = await sync(c, { staffSignIns: [cashierIn], commands: [three, one] });
    expect(first.payload.acknowledgements).toEqual([
      expect.objectContaining({ sequence: 1, status: "committed" }),
      expect.objectContaining({ sequence: 3, status: "held", error: expect.objectContaining({ code: "SEQUENCE_GAP", retryable: false }) }),
    ]);
    expect(first.payload.committedThroughSequence).toBe(1);
    expect(await prisma.offlineJournalReview.findFirst({ where: { tenantId: c.fx.tenantId, recordId: three.payload.commandId } }))
      .toMatchObject({ outcome: "held", errorCode: "SEQUENCE_GAP", sequence: 3n });

    // 4, 2, 3: all accepted in order; the gap closes.
    const second = await sync(c, { commands: [four, two, three] });
    expect(second.payload.acknowledgements.map((a) => [a.sequence, a.status])).toEqual([[2, "committed"], [3, "committed"], [4, "committed"]]);
    expect(second.payload.committedThroughSequence).toBe(4);
    expect(await onHand(c.batches.main)).toBe(17);
  });

  it("refuses a modified upload or a broken hash chain as REPLAY_CONFLICT and keeps it for review", async () => {
    const c = await counter({ main: 20 });
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    const open = j.open(cashierIn, 0);
    const sale = j.sale(cashierIn, [[c.batches.main, 2]]);
    const accepted = await sync(c, { staffSignIns: [cashierIn], commands: [open, sale] });
    const original = saleAck(accepted.payload.acknowledgements[1]!);

    // Same command ID, other content.
    const changed = j.tamper(sale, { lines: [{ ...sale.payload.lines[0]!, quantity: 1 }] });
    const conflict = await sync(c, { commands: [changed] });
    expect(conflict.payload.acknowledgements[0]).toMatchObject({ status: "rejected", error: { code: "REPLAY_CONFLICT" } });
    // Same sequence, another command ID.
    const sameSequence = j.tamper(sale, { commandId: randomUUID() });
    const conflict2 = await sync(c, { commands: [sameSequence] });
    expect(conflict2.payload.acknowledgements[0]).toMatchObject({ status: "rejected", error: { code: "REPLAY_CONFLICT" } });
    const kept = await prisma.offlineJournalReview.findMany({ where: { tenantId: c.fx.tenantId, outcome: "conflict" } });
    expect(kept.map((r) => r.originalRecordHash)).toEqual([accepted.payload.committedThroughHash, accepted.payload.committedThroughHash]);
    // Resending the same changed bytes is still the same retained upload, counted again.
    await sync(c, { commands: [changed] });
    expect((await prisma.offlineJournalReview.findFirstOrThrow({ where: { tenantId: c.fx.tenantId, recordHash: sha256(commandText(changed.payload)) } })).attempts).toBe(2);
    await expect(prisma.offlineJournalReview.deleteMany({ where: { tenantId: c.fx.tenantId } })).rejects.toThrow(/retained/);

    // A next entry that does not name the accepted head.
    const forked = j.sale(cashierIn, [[c.batches.main, 1]], { previousCommandHash: randomBytes(32).toString("hex") });
    const broken = await sync(c, { commands: [forked] });
    expect(broken.payload.acknowledgements[0]).toMatchObject({ sequence: 3, status: "rejected", error: { code: "REPLAY_CONFLICT" } });
    expect(broken.payload.committedThroughSequence).toBe(2);

    // The original stands, once.
    const replay = await sync(c, { commands: [sale] });
    expect(saleAck(replay.payload.acknowledgements[0]!)).toMatchObject({ status: "duplicate", saleId: original.saleId });
    expect(await prisma.sale.count({ where: { tenantId: c.fx.tenantId } })).toBe(1);
    expect(await onHand(c.batches.main)).toBe(18);
  });

  it("gives concurrent identical retries one sale and the same receipt", async () => {
    const c = await counter({ main: 20 });
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    const commands = [j.open(cashierIn, 0), j.sale(cashierIn, [[c.batches.main, 4]])];
    const results = await Promise.all([1, 2, 3, 4].map(() => sync(c, { staffSignIns: [cashierIn], commands })));
    const saleAcks = results.map((r) => saleAck(r.payload.acknowledgements[1]!));
    expect(new Set(saleAcks.map((a) => a.saleId)).size).toBe(1);
    expect(saleAcks.filter((a) => a.status === "committed")).toHaveLength(1);
    expect(await prisma.sale.count({ where: { tenantId: c.fx.tenantId } })).toBe(1);
    expect(await onHand(c.batches.main)).toBe(16);
    expect(await prisma.offlineStaffSignIn.count({ where: { tenantId: c.fx.tenantId } })).toBe(1);
  });

  it("partition: snapshot 10, 7 sold online, 5 offline — keeps the sale, opens a 2-unit case and blocks only that batch", async () => {
    const c = await counter({ partition: 10, other: 20 });
    expect(c.snapshot.lines.find((l) => l.batchId === c.batches.partition)!.availableQuantity).toBe(10);

    // While the offline counter is cut off, another counter sells 7 online.
    await sales.checkout(c.fx.tenantId, c.fx.mainBranchId, c.owner.userId, [],
      { items: [{ productId: c.fx.productId, batchId: c.batches.partition, qty: 7, unitPrice: "15.50" }] } as never, undefined);
    expect(await onHand(c.batches.partition)).toBe(3);

    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    const open = j.open(cashierIn, 0);
    const sale = j.sale(cashierIn, [[c.batches.partition, 5]]);
    const response = await sync(c, { staffSignIns: [cashierIn], commands: [open, sale] });
    const ack = saleAck(response.payload.acknowledgements[1]!);
    expect(ack).toMatchObject({ status: "committed", stockPosting: "pending_reconciliation" });
    // The accepted sale advances the watermark although its stock is pending.
    expect(response.payload.committedThroughSequence).toBe(2);

    const saleRow = await prisma.sale.findUniqueOrThrow({ where: { id: ack.saleId }, include: { payments: true } });
    expect(saleRow).toMatchObject({ stockPosting: "pending_reconciliation", offlineCommandId: sale.payload.commandId });
    expect(saleRow.payments).toHaveLength(1);
    // Nothing posted, nothing clamped, nothing invented: the 3 left on the shelf are untouched.
    expect(await onHand(c.batches.partition)).toBe(3);
    expect(await prisma.stockLedger.count({ where: { tenantId: c.fx.tenantId, referenceId: ack.saleId } })).toBe(0);
    const discrepancy = await prisma.offlineStockDiscrepancy.findUniqueOrThrow({
      where: { id: ack.reconciliationCaseId! }, include: { lines: true, blocks: true },
    });
    expect(discrepancy).toMatchObject({ status: "open", saleId: ack.saleId, commandId: sale.payload.commandId,
      snapshotId: c.snapshot.snapshotId, snapshotVersion: c.snapshot.snapshotVersion });
    expect(discrepancy.lines).toEqual([expect.objectContaining({
      batchId: c.batches.partition, soldQuantity: 5, availableQuantityAtSync: 3, shortfallQuantity: 2, reason: "shortfall",
    })]);
    expect(discrepancy.blocks.map((b) => [b.batchId, b.releasedAt])).toEqual([[c.batches.partition, null]]);

    // Central checkout refuses the blocked batch, by name or by FEFO, and sells the other one.
    await expect(sales.checkout(c.fx.tenantId, c.fx.mainBranchId, c.owner.userId, [],
      { items: [{ productId: c.fx.productId, batchId: c.batches.partition, qty: 1, unitPrice: "15.50" }] } as never, undefined))
      .rejects.toMatchObject({ response: { code: "BATCH_STOCK_REVIEW" } });
    const fefo = await sales.checkout(c.fx.tenantId, c.fx.mainBranchId, c.owner.userId, [],
      { items: [{ productId: c.fx.productId, qty: 2, unitPrice: "15.50" }] } as never, undefined);
    expect(fefo!.items.map((i) => i.batchId)).toEqual([c.batches.other]);
    expect(await onHand(c.batches.other)).toBe(18);
    // The pending sale can't be voided: that would put back stock it never took.
    await expect(sales.voidSale(c.fx.tenantId, c.fx.mainBranchId, c.owner.userId,
      [{ branchId: c.fx.mainBranchId, role: RoleName.owner }], ack.saleId, "test"))
      .rejects.toMatchObject({ response: { code: "STOCK_POSTING_PENDING" } });

    // A fresh snapshot for any counter at this branch marks the blocked batch for review.
    const state = await prisma.$transaction((tx) => acceptedJournalState(tx, { ...c.identity, enrollmentId: randomUUID() }));
    expect([...state.reviewRequiredBatchIds]).toEqual([c.batches.partition]);

    // The response was lost: the retry returns the original receipt, case included.
    const retry = await sync(c, { staffSignIns: [cashierIn], commands: [open, sale] });
    expect(saleAck(retry.payload.acknowledgements[1]!)).toEqual({ ...ack, status: "duplicate" });
    expect(await prisma.offlineStockDiscrepancy.count({ where: { tenantId: c.fx.tenantId } })).toBe(1);

    // A later offline sale from the blocked batch waits too, even though 3 are on the shelf:
    // that batch's count is under review, so nothing more is posted into it.
    const another = j.sale(cashierIn, [[c.batches.partition, 1]]);
    const second = saleAck((await sync(c, { commands: [another] })).payload.acknowledgements[0]!);
    expect(second).toMatchObject({ status: "committed", stockPosting: "pending_reconciliation" });
    expect(await prisma.offlineStockDiscrepancyLine.findFirstOrThrow({ where: { caseId: second.reconciliationCaseId! } }))
      .toMatchObject({ soldQuantity: 1, availableQuantityAtSync: 3, shortfallQuantity: 0, reason: "batch_under_review" });
    expect(await onHand(c.batches.partition)).toBe(3);
  });

  it("rebases the counter's next authority over its accepted journal: posted sales come off, a pending one stays blocked", async () => {
    const c = await counter({ partition: 10, other: 20 });
    await sales.checkout(c.fx.tenantId, c.fx.mainBranchId, c.owner.userId, [],
      { items: [{ productId: c.fx.productId, batchId: c.batches.partition, qty: 7, unitPrice: "15.50" }] } as never, undefined);
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    const commands = [j.open(cashierIn, 0), j.sale(cashierIn, [[c.batches.other, 4]]), j.sale(cashierIn, [[c.batches.partition, 5]])];
    const response = await sync(c, { staffSignIns: [cashierIn], commands });
    expect(response.payload.acknowledgements.map((a) => a.status)).toEqual(["committed", "committed", "committed"]);

    // The drain's fresh snapshot: stock and watermark from one view, after the upload.
    const renewed = await issueOfflineAuthority(prisma as never, access, {
      signer, defaultVatRatePercent: 18,
      authenticate: async () => ({ identity: c.identity, commandId: randomUUID() }),
      readState: acceptedJournalState,
    });
    const snapshot = renewed.snapshot.payload;
    expect(snapshot).toMatchObject({
      snapshotVersion: c.snapshot.snapshotVersion + 1,
      includedThroughSequence: 3,
      includedThroughHash: response.payload.committedThroughHash,
    });
    const line = (batchId: string) => snapshot.lines.find((l) => l.batchId === batchId);
    // The posted sale is in central stock, so it is in the snapshot: 20 - 4, not sold twice.
    expect(line(c.batches.other)).toMatchObject({ availableQuantity: 16, stockReviewRequired: false });
    // The pending one holds its batch: advancing the watermark doesn't make those units sellable.
    expect(line(c.batches.partition)).toMatchObject({ stockReviewRequired: true });
    expect(response.payload.committedThroughHash).toBe(sha256(commandText(commands[2]!.payload)));
  });

  it("acknowledges support records in the same upload, and refuses a counter login from another counter", async () => {
    const c = await counter({ main: 5 });
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    const open = j.open(cashierIn, 0);
    const incident = c.device.sign({
      contractVersion: 1, kind: "sale_incident", recordId: randomUUID(), identity: c.identity,
      saleCommandId: randomUUID(), recordedByUserId: c.cashier.userId, staffSignInId: cashierIn.payload.staffSignInId,
      workSessionId: cashierIn.payload.session.workSessionId, recordedAt: j.offlineStartedAt, category: "other",
      description: "Customer queried the change",
    }, c.identity.keyId);
    const response = await sync(c, { staffSignIns: [cashierIn], commands: [open], supportRecords: [incident as never] });
    expect(response.payload.supportAcknowledgements).toEqual([
      expect.objectContaining({ recordId: incident.payload.recordId, status: "held", error: expect.objectContaining({ code: "RECONCILIATION_REQUIRED" }) }),
    ]);
    expect(response.payload.acknowledgements.map((a) => a.status)).toEqual(["committed"]);

    // A PIN-opened login bound to some other counter's staff session cannot upload this journal.
    const elsewhere = await prisma.terminalStaffSession.findFirstOrThrow({ where: { tenantId: c.fx.tenantId } });
    await prisma.terminalStaffSession.update({ where: { id: elsewhere.id }, data: { closedAt: new Date() } });
    const other = await prisma.terminalStaffSession.create({
      data: { ...elsewhere, id: randomUUID(), enrollmentId: elsewhere.enrollmentId, closedAt: null, openedAt: new Date() },
    });
    await expect(journal.sync({ ...c.cashier, counter: { workSessionId: other.id, branchId: c.fx.mainBranchId } },
      c.fx.mainBranchId, request(c, { commands: [open] }))).resolves.toBeDefined();
    await expect(journal.sync({ ...c.cashier, counter: { workSessionId: randomUUID(), branchId: c.fx.mainBranchId } },
      c.fx.mainBranchId, request(c, { commands: [open] }))).rejects.toMatchObject({ response: { code: "IDENTITY_MISMATCH" } });
  });

  it("keeps a whole sale pending when one of its batches falls short, and blocks each of its batches", async () => {
    const c = await counter({ short: 4, fine: 10 });
    await prisma.$transaction((t) => stock.issue(
      t, { tenantId: c.fx.tenantId, branchId: c.fx.mainBranchId, userId: c.fx.ownerId, referenceType: "adjustment", referenceId: randomUUID() },
      [{ productId: c.fx.productId, batchId: c.batches.short, qty: 3, movementType: StockMovementType.adjustment_out }],
    ));
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    const response = await sync(c, {
      staffSignIns: [cashierIn],
      commands: [j.open(cashierIn, 0), j.sale(cashierIn, [[c.batches.short, 2], [c.batches.fine, 1]])],
    });
    const ack = saleAck(response.payload.acknowledgements[1]!);
    expect(ack.stockPosting).toBe("pending_reconciliation");
    expect(await onHand(c.batches.fine)).toBe(10);
    const lines = await prisma.offlineStockDiscrepancyLine.findMany({ where: { caseId: ack.reconciliationCaseId! }, orderBy: { reason: "asc" } });
    expect(lines.map((l) => [l.batchId, l.reason, l.shortfallQuantity])).toEqual(
      [[c.batches.fine, "sale_pending", 0], [c.batches.short, "shortfall", 1]].sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
    );
    expect(await prisma.batchSaleBlock.count({ where: { caseId: ack.reconciliationCaseId!, releasedAt: null } })).toBe(2);
  });

  it("recovers a journal after the grant expired, but refuses a sale made after expiry", async () => {
    const c = await counter({ main: 20 });
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    const commands = [j.open(cashierIn, 0), j.sale(cashierIn, [[c.batches.main, 1]])];
    const afterExpiry = c.grant.expiresAt + 60 * 60 * 1000;
    // Late arrival alone is no reason to refuse: these happened while the grant was valid.
    const late = await sync(c, { staffSignIns: [cashierIn], commands }, afterExpiry);
    expect(late.payload.acknowledgements.map((a) => a.status)).toEqual(["committed", "committed"]);
    const replay = await sync(c, { commands }, afterExpiry + 1);
    expect(replay.payload.acknowledgements.map((a) => a.status)).toEqual(["duplicate", "duplicate"]);
    const tooLate = j.sale(cashierIn, [[c.batches.main, 1]], { occurredAt: c.grant.expiresAt });
    const refused = await sync(c, { commands: [tooLate] }, afterExpiry);
    expect(refused.payload.acknowledgements[0]).toMatchObject({ status: "rejected", error: { code: "GRANT_EXPIRED" } });
    expect(await onHand(c.batches.main)).toBe(19);
  });

  it("from a revoked counter, replays what was accepted and holds anything new for review", async () => {
    const c = await counter({ main: 20 });
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    const accepted = [j.open(cashierIn, 0), j.sale(cashierIn, [[c.batches.main, 1]])];
    await sync(c, { staffSignIns: [cashierIn], commands: accepted });
    await prisma.$transaction((tx) => trust.revokeEnrollment(tx, c.owner, c.fx.mainBranchId, c.identity.enrollmentId, "Stolen"));

    const later = j.sale(cashierIn, [[c.batches.main, 1]]);
    // An owner recovers the journal with an ordinary login: the counter can no longer sign in.
    const response = await journal.sync(c.owner, c.fx.mainBranchId, request(c, { commands: [...accepted, later] }));
    expect(response.payload.acknowledgements.map((a) => a.status)).toEqual(["duplicate", "duplicate", "held"]);
    expect(response.payload.acknowledgements[2]).toMatchObject({ error: { code: "TERMINAL_REVOKED" } });
    expect(await prisma.sale.count({ where: { tenantId: c.fx.tenantId } })).toBe(1);
    expect(await prisma.offlineJournalReview.findFirstOrThrow({ where: { tenantId: c.fx.tenantId, recordId: later.payload.commandId } }))
      .toMatchObject({ outcome: "held", errorCode: "TERMINAL_REVOKED" });
  });

  it("refuses the whole upload when anything is not signed by the enrollment's key, and keeps nothing", async () => {
    const c = await counter({ main: 20 });
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    const open = j.open(cashierIn, 0);
    const forged = { ...open, signature: terminalDevice().sign(open.payload, c.identity.keyId).signature };
    await expect(sync(c, { staffSignIns: [cashierIn], commands: [forged] })).rejects.toMatchObject({ response: { code: "INVALID_SIGNATURE" } });
    await expect(sync(c, { commands: [{ ...open, payload: { ...open.payload, extra: 1 } } as never] }))
      .rejects.toMatchObject({ response: { code: "INVALID_COMMAND" } });
    expect(await prisma.offlineStaffSignIn.count({ where: { tenantId: c.fx.tenantId } })).toBe(0);
    expect(await prisma.terminalCommandReceipt.count({ where: { tenantId: c.fx.tenantId } })).toBe(0);
  });

  it("validates each sale against the signed snapshot: no repricing, no unknown sign-in", async () => {
    const c = await counter({ main: 20 });
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    await sync(c, { staffSignIns: [cashierIn], commands: [j.open(cashierIn, 0)] });
    // Today's catalog price changed; the offline sale still carries the snapshot's price.
    await prisma.batch.update({ where: { id: c.batches.main }, data: { sellingPrice: "99.00" } });
    const good = j.sale(cashierIn, [[c.batches.main, 1]]);
    expect(saleAck((await sync(c, { commands: [good] })).payload.acknowledgements[0]!).status).toBe("committed");
    const sold = await prisma.saleItem.findFirstOrThrow({ where: { tenantId: c.fx.tenantId } });
    expect(sold.unitPrice.toFixed(2)).toBe("15.50");

    const repriced = j.sale(cashierIn, [[c.batches.main, 1]]);
    const cheaper = j.tamper(repriced, { lines: [{ ...repriced.payload.lines[0]!, unitPriceMinor: 1 }] });
    expect((await sync(c, { commands: [cheaper] })).payload.acknowledgements[0])
      .toMatchObject({ status: "rejected", error: { code: "INVALID_COMMAND" } });

    const stranger = j.signIn(c.cashier.userId, cashierIn.payload.session.workSessionId);
    // Not uploaded: the sale waits for its sign-in rather than being refused for good.
    const waiting = j.tamper(repriced, { staffSignInId: stranger.payload.staffSignInId });
    expect((await sync(c, { commands: [waiting] })).payload.acknowledgements[0])
      .toMatchObject({ status: "held", error: { code: "SESSION_INVALID" } });
    expect((await sync(c, { staffSignIns: [stranger], commands: [waiting] })).payload.acknowledgements[0])
      .toMatchObject({ status: "committed" });
  });
});
