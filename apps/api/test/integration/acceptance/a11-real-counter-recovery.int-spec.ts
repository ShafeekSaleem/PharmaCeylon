import { randomUUID } from "node:crypto";
import { acceptedJournalState, issueOfflineAuthority } from "../../../src/terminals/offline-authority-issuance";
import { activeOutage } from "../../../../pos-desktop/src/main/terminal/offline-journal";
import { readJournalSyncView } from "../../../../pos-desktop/src/main/terminal/offline-journal-sync";
import { checkoutSyncPause, drainHolds } from "../../../../pos-desktop/src/main/terminal/reconnect-drain";
import { access, journal, prisma, signer, supportEvidence, type Counter } from "../offline-counter.kit";
import { effects } from "./acceptance.kit";
import { CASHIER_PIN, closeDesktop, pendingUpload, realCounter, uploader, type Desktop } from "./real-counter.kit";

/**
 * P5 #51 operational-readiness boxes, run on evidence written by the real P4 #50 counter
 * (`real-counter.kit`): support records synced on their own, the reconnect drain with a card
 * payment still uncertain, and approved card payments no sale used.
 */
afterEach(closeDesktop);

afterAll(async () => {
  await prisma.$disconnect();
});

const renewal = (c: Counter) =>
  issueOfflineAuthority(prisma as never, access, {
    signer,
    defaultVatRatePercent: 18,
    authenticate: async () => ({ identity: c.identity, commandId: randomUUID() }),
    readState: acceptedJournalState,
  });

const supportRows = (c: Counter) =>
  prisma.offlineSupportRecord.findMany({ where: { tenantId: c.fx.tenantId }, orderBy: { receivedAt: "asc" } });

function itemsOf(c: Counter, batch = c.batches.main!) {
  const line = c.snapshot.lines.find((l) => l.batchId === batch)!;
  return (quantity: number) => [{ snapshotLineId: line.snapshotLineId, quantity }];
}

function openTill(c: Counter, d: Desktop) {
  d.staff.signIn(c.cashier.userId, CASHIER_PIN);
  d.staff.openShift(CASHIER_PIN, { totalMinor: 0, lines: [] });
  d.advance(5_000);
}

describe("A11: recovery evidence written by the real P4 counter", () => {
  it("support evidence syncs without sale commands: held until its journal arrives, idempotent, and altered content under a used ID conflicts", async () => {
    const { c, key, d } = await realCounter({ main: 20 });
    const items = itemsOf(c);
    openTill(c, d);
    const cash = d.sale.commit({ checkoutDraftId: randomUUID(), items: items(1), cashTenderedMinor: 10_000 });
    d.advance(5_000);
    // A card the customer's bank declined: card evidence with no sale of its own.
    const declined = d.sale.prepareCard({ checkoutDraftId: randomUUID(), items: items(2), amountMinor: 1_000 });
    d.advance(5_000);
    d.sale.recordCardOutcome({ attemptId: declined.attemptId, outcome: { kind: "declined", reference: "RRN-DECLINED" } });
    d.advance(5_000);
    // A note on the cash sale, from the counter's offline records screen.
    d.support(c.cashier.userId).recordIncident({
      saleCommandId: cash.saleCommandId,
      category: "customer_dispute",
      description: "Customer says the change was short; drawer to be checked at close",
    });
    const body = await pendingUpload(c, d);
    expect(body.supportRecords.map((r) => r.payload.kind).sort()).toEqual([
      "external_card_attempt",
      "external_card_attempt",
      "sale_incident",
    ]);
    const before = await effects(c);
    const at = () => Math.max(Date.now(), d.trusted() + 1_000);

    // Support records alone, before the journal they cite: kept, held, and nothing moves.
    const alone = await journal.sync(c.cashier, c.fx.mainBranchId, { ...body, staffSignIns: [], commands: [] }, at());
    expect(alone.payload.acknowledgements).toEqual([]);
    expect(alone.payload.supportAcknowledgements.map((a) => a.status)).toEqual(["held", "held", "held"]);
    expect(alone.payload.supportEvidence).toMatchObject({ heldRecords: 3, supportRecordsAccepted: false });
    expect(await effects(c)).toEqual(before);
    // The same records again: still three rows, each under its original record ID.
    await journal.sync(c.cashier, c.fx.mainBranchId, { ...body, staffSignIns: [], commands: [] }, at());
    expect(await supportRows(c)).toHaveLength(3);

    // Changed content under a used record ID, signed by the counter's own key: a conflict, kept apart.
    const note = body.supportRecords.find((r) => r.payload.kind === "sale_incident")!;
    const altered = key.sign({ ...note.payload, description: "Edited after the fact" }, "command");
    const conflict = await journal.sync(c.cashier, c.fx.mainBranchId, { ...body, staffSignIns: [], commands: [], supportRecords: [altered] }, at());
    // On the wire a conflict answers `held` with REPLAY_CONFLICT; the original stays as it was.
    expect(conflict.payload.supportAcknowledgements[0]).toMatchObject({ status: "held", error: { code: "REPLAY_CONFLICT" } });
    expect(await prisma.offlineSupportConflict.count({ where: { tenantId: c.fx.tenantId } })).toBe(1);
    expect((await supportRows(c)).find((r) => r.recordId === note.payload.recordId)).toMatchObject({
      description: "Customer says the change was short; drawer to be checked at close",
    });

    // The counter reconnects and sends its journal: the held records are repaired without resending them.
    const up = uploader(c, d);
    await up.sync.tick({ force: true });
    expect(up.replies.flatMap((r) => r.payload.acknowledgements.map((a) => a.status))).toEqual(["committed", "committed"]);
    expect(up.replies.at(-1)!.payload.supportEvidence).toEqual({
      heldRecords: 0,
      rejectedRecords: 0,
      unresolvedCardAttempts: 0,
      supportRecordsAccepted: true,
      paymentAttemptsResolved: true,
    });
    expect((await supportRows(c)).map((r) => r.status)).toEqual(["accepted", "accepted", "accepted"]);
    // The note never changes the sale it is about.
    const sale = await prisma.sale.findFirstOrThrow({ where: { tenantId: c.fx.tenantId, offlineCommandId: cash.saleCommandId } });
    expect(sale.grandTotal.mul(100).toNumber()).toBe(cash.totalMinor);
    expect(await effects(c)).toMatchObject({ sales: 1, payments: 1 });
    expect(drainHolds(d.local.db, c.identity.enrollmentId)).toEqual({ cards: 0, records: 0, refused: 0 });
  });

  it("reconnect drain: a failed upload keeps the outage, an uncertain card holds it, and recovery during the drain lets checkout resume", async () => {
    const { c, d } = await realCounter({ main: 20 });
    const items = itemsOf(c);
    openTill(c, d);
    d.sale.commit({ checkoutDraftId: randomUUID(), items: items(1), cashTenderedMinor: 10_000 });
    d.advance(5_000);
    // The power flickers at the card machine: the counter can't tell whether the card was charged.
    const draft = randomUUID();
    const card = d.sale.prepareCard({ checkoutDraftId: draft, items: items(2), amountMinor: 3_658 });
    d.advance(5_000);
    d.sale.recordCardOutcome({ attemptId: card.attemptId, outcome: { kind: "not_sure" } });
    const outage = activeOutage(d.local.db, c.identity.enrollmentId)!;
    expect(outage).not.toBeNull();
    const grantExpiry = c.grant.expiresAt;

    // Back online, but the first upload fails mid-flight: nothing is reset.
    d.setMode("online");
    await pendingUpload(c, d);
    expect(activeOutage(d.local.db, c.identity.enrollmentId)).toEqual(outage);
    expect(readJournalSyncView(d.local.db, c.identity.enrollmentId)).toMatchObject({ accepted: 0, waiting: 2 });
    expect(checkoutSyncPause(d.local.db, c.identity.enrollmentId)).not.toBeNull();

    // The upload goes through: the journal is accepted, but the uncertain card still holds the drain.
    const up = uploader(c, d);
    await up.sync.tick({ force: true });
    expect(readJournalSyncView(d.local.db, c.identity.enrollmentId)).toMatchObject({ accepted: 2, waiting: 0 });
    expect(up.replies.at(-1)!.payload.supportEvidence).toMatchObject({ paymentAttemptsResolved: false, unresolvedCardAttempts: 1 });
    expect(drainHolds(d.local.db, c.identity.enrollmentId)).toMatchObject({ cards: 1 });
    // Fresh stock covering the journal is not enough while the card is unresolved: no resume, no new timer.
    expect(d.install(await renewal(c))).toBe("drain_incomplete");
    expect(activeOutage(d.local.db, c.identity.enrollmentId)).toEqual(outage);
    expect(checkoutSyncPause(d.local.db, c.identity.enrollmentId)).not.toBeNull();

    // Recovery during the drain, on the counter's card-settlement screen: the slip shows the card
    // was approved, then the sale was abandoned.
    d.advance(5_000);
    const settle = d.support(c.cashier.userId);
    settle.recordCardOutcome({
      attemptId: card.attemptId,
      outcome: {
        kind: "approved",
        reference: "RRN-FLICKER",
        approvalCode: "OK7",
        approvedAt: new Date(d.trusted() - 4_000).toISOString(),
      },
    });
    d.advance(1_000);
    settle.recordCardOutcome({
      attemptId: card.attemptId,
      outcome: { kind: "not_used", settlement: "refund_owed", reversalReference: null, reason: "Customer left during the power cut" },
    });
    await up.sync.tick({ force: true });
    // Settled at the counter, so the drain can finish. The server still counts it as money owed back,
    // held for a manager: collected funds apart from any sale.
    expect(drainHolds(d.local.db, c.identity.enrollmentId)).toEqual({ cards: 0, records: 0, refused: 0 });
    expect(up.replies.at(-1)!.payload.supportEvidence).toMatchObject({ paymentAttemptsResolved: false, unresolvedCardAttempts: 1 });
    expect((await supportEvidence.listHeld(c.owner, c.fx.mainBranchId)).map((h) => [h.attemptId, h.heldReason])).toContainEqual([
      card.attemptId,
      "card_not_used",
    ]);

    // Now the fresh pair installs, the outage ends and checkout resumes; the old expiry did not move meanwhile.
    expect(d.install(await renewal(c))).toBe("installed");
    expect(activeOutage(d.local.db, c.identity.enrollmentId)).toBeNull();
    expect(checkoutSyncPause(d.local.db, c.identity.enrollmentId)).toBeNull();
    expect(c.grant.expiresAt).toBe(grantExpiry);
    expect(await effects(c)).toMatchObject({ sales: 1, payments: 1 });
  });

  it("an approved card no sale used is kept as collected money for a manager, apart from the sale, with no second charge or sale", async () => {
    const { c, d } = await realCounter({ main: 20 });
    const items = itemsOf(c);
    openTill(c, d);
    const draft = randomUUID();
    const first = d.sale.prepareCard({ checkoutDraftId: draft, items: items(3), amountMinor: 5_487 });
    d.sale.recordCardOutcome({
      attemptId: first.attemptId,
      outcome: { kind: "approved", reference: "RRN-FIRST", approvalCode: "OK1", approvedAt: d.trusted() },
    });
    d.advance(5_000);
    // The customer takes one item off: the approved card no longer fits, and is reversed on the machine.
    d.sale.recordCardOutcome({
      attemptId: first.attemptId,
      outcome: { kind: "not_used", settlement: "reversed_on_machine", reversalReference: "VOID-1", reason: "Customer took one item off" },
    });
    const second = d.sale.prepareCard({ checkoutDraftId: draft, items: items(2), amountMinor: 3_658 });
    d.sale.recordCardOutcome({
      attemptId: second.attemptId,
      outcome: { kind: "approved", reference: "RRN-SECOND", approvalCode: "OK2", approvedAt: d.trusted() },
    });
    d.advance(5_000);
    const sold = d.sale.commit({ checkoutDraftId: draft, items: items(2), cashTenderedMinor: 0 });
    d.advance(5_000);
    // Another card approved, then the sale abandoned: the money is owed back.
    const abandoned = d.sale.prepareCard({ checkoutDraftId: randomUUID(), items: items(1), amountMinor: 1_829 });
    d.sale.recordCardOutcome({
      attemptId: abandoned.attemptId,
      outcome: { kind: "approved", reference: "RRN-OWED", approvalCode: "OK3", approvedAt: d.trusted() },
    });
    d.advance(5_000);
    d.sale.recordCardOutcome({
      attemptId: abandoned.attemptId,
      outcome: { kind: "not_used", settlement: "refund_owed", reversalReference: null, reason: "Customer walked out" },
    });

    const up = uploader(c, d);
    await up.sync.tick({ force: true });
    await up.sync.tick({ force: true });
    // One sale, paid by the second card at its original amount and reference.
    const sales = await prisma.sale.findMany({ where: { tenantId: c.fx.tenantId }, include: { payments: true } });
    expect(sales).toHaveLength(1);
    expect(sales[0]).toMatchObject({ offlineCommandId: sold.saleCommandId });
    expect(sales[0]!.payments.map((p) => [p.method, p.reference, p.amount.mul(100).toNumber()])).toEqual([
      ["card", "RRN-SECOND", 3_658],
    ]);
    // The unused approvals stay as collected-money evidence for a manager, never as sales or refunds.
    const notUsed = (await supportRows(c)).filter((r) => r.cardState === "not_used");
    expect(notUsed.map((r) => [r.attemptId, r.status, r.heldReason]).sort()).toEqual(
      [
        [first.attemptId, "held", "card_not_used"],
        [abandoned.attemptId, "held", "card_not_used"],
      ].sort(),
    );
    const held = await supportEvidence.listHeld(c.owner, c.fx.mainBranchId);
    expect(held.filter((h) => h.heldReason === "card_not_used").map((h) => h.attemptId).sort()).toEqual(
      [first.attemptId, abandoned.attemptId].sort(),
    );
    expect(await prisma.saleRefundRequest.count({ where: { tenantId: c.fx.tenantId } })).toBe(0);
    // The payment attempts are settled on the counter, so the drain can finish.
    expect(drainHolds(d.local.db, c.identity.enrollmentId)).toMatchObject({ cards: 0 });

    // A resend of everything adds nothing: no second sale, payment or record.
    const rows = (await supportRows(c)).length;
    await journal.sync(c.cashier, c.fx.mainBranchId, up.sent[0], Math.max(Date.now(), d.trusted() + 1_000));
    expect(await effects(c)).toMatchObject({ sales: 1, payments: 1 });
    expect(await supportRows(c)).toHaveLength(rows);
  });
});
