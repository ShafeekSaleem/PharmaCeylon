import { randomUUID } from "node:crypto";
import { counter, journal, offlineJournal, onHand, prisma, request, saleAck, sync, trust } from "../offline-counter.kit";
import { branch, effects, reviews, statuses } from "./acceptance.kit";

/**
 * P5 #51 acceptance box A5 — fixture run: grant expiry, revocation and a lost device do not erase
 * an offline journal; exact replays stay replay-safe; questionable evidence goes to review rather
 * than being accepted or thrown away.
 */
afterAll(async () => {
  await prisma.$disconnect();
});

const hour = 60 * 60 * 1000;

describe("A5: losing offline authority never erases the journal", () => {
  it("grant expiry: entries made in time are accepted late and replay safely; one made after expiry goes to review", async () => {
    const c = await counter({ main: 20 });
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    const inTime = [j.open(cashierIn, 0), j.sale(cashierIn, [[c.batches.main, 2]])];
    const afterExpiry = c.grant.expiresAt + hour;

    const late = await sync(c, { staffSignIns: [cashierIn], commands: inTime }, afterExpiry);
    expect(statuses(late.payload.acknowledgements)).toEqual(["committed", "committed"]);
    const replay = await sync(c, { staffSignIns: [cashierIn], commands: inTime }, afterExpiry + hour);
    expect(statuses(replay.payload.acknowledgements)).toEqual(["duplicate", "duplicate"]);
    expect(saleAck(replay.payload.acknowledgements[1]!).saleId).toBe(saleAck(late.payload.acknowledgements[1]!).saleId);

    // Made at expiry: refused as a sale, but kept and listed for a manager to decide.
    const tooLate = j.sale(cashierIn, [[c.batches.main, 1]], { occurredAt: c.grant.expiresAt });
    const refused = await sync(c, { commands: [tooLate] }, afterExpiry);
    expect(refused.payload.acknowledgements[0]).toMatchObject({ status: "rejected", error: { code: "GRANT_EXPIRED" } });
    const listed = await reviews.list(c.fx.tenantId, branch(c));
    expect(listed).toEqual([expect.objectContaining({ state: "open", kind: "ordinary_sale", sequence: 3, refusal: expect.objectContaining({ code: "GRANT_EXPIRED" }) })]);
    expect(await prisma.offlineJournalReview.findFirstOrThrow({ where: { tenantId: c.fx.tenantId, recordId: tooLate.payload.commandId } }))
      .toMatchObject({ outcome: "rejected", errorCode: "GRANT_EXPIRED" });
    expect(await effects(c)).toMatchObject({ sales: 1 });
    expect(await onHand(c.batches.main)).toBe(18);
    // Retained evidence can't be deleted.
    await expect(prisma.offlineJournalReview.deleteMany({ where: { tenantId: c.fx.tenantId } })).rejects.toThrow(/retained/);
  });

  it("revocation: accepted entries replay as before, the next is held for review, the rest stay queued", async () => {
    const c = await counter({ main: 20 });
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    const accepted = [j.open(cashierIn, 0), j.sale(cashierIn, [[c.batches.main, 1]])];
    await sync(c, { staffSignIns: [cashierIn], commands: accepted });
    await prisma.$transaction((tx) => trust.revokeEnrollment(tx, c.owner, branch(c), c.identity.enrollmentId, "Suspected misuse"));

    const later = [j.sale(cashierIn, [[c.batches.main, 2]]), j.sale(cashierIn, [[c.batches.main, 3]])];
    const upload = () => journal.sync(c.owner, branch(c), request(c, { staffSignIns: [cashierIn], commands: [...accepted, ...later] }));
    const first = await upload();
    // Processing stops at the first held entry: 4 is not acknowledged, so the counter keeps it.
    expect(statuses(first.payload.acknowledgements)).toEqual(["duplicate", "duplicate", "held"]);
    expect(first.payload.acknowledgements[2]).toMatchObject({ error: { code: "TERMINAL_REVOKED" } });
    expect(first.payload.committedThroughSequence).toBe(2);
    // Replaying the exact same upload changes nothing and counts the attempt.
    const second = await upload();
    expect(statuses(second.payload.acknowledgements)).toEqual(["duplicate", "duplicate", "held"]);
    const kept = await prisma.offlineJournalReview.findMany({
      where: { tenantId: c.fx.tenantId, recordId: { in: later.map((l) => l.payload.commandId) } }, orderBy: { sequence: "asc" },
    });
    expect(kept.map((k) => [Number(k.sequence), k.outcome, k.errorCode, k.attempts])).toEqual([[3, "held", "TERMINAL_REVOKED", 2]]);
    expect(await effects(c)).toMatchObject({ sales: 1 });
    expect(await onHand(c.batches.main)).toBe(19);
  });

  it("lost device: a journal never synced before the counter was revoked is held, never committed or dropped", async () => {
    const c = await counter({ main: 20 });
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    const commands = [j.open(cashierIn, 0), j.sale(cashierIn, [[c.batches.main, 2]]), j.sale(cashierIn, [[c.batches.main, 1]])];
    // The PC goes missing mid-outage; the owner revokes it. Later its disk turns up and the owner uploads it.
    await prisma.$transaction((tx) => trust.revokeEnrollment(tx, c.owner, branch(c), c.identity.enrollmentId, "Counter PC lost"));
    const recovered = await journal.sync(c.owner, branch(c), request(c, { staffSignIns: [cashierIn], commands }));
    // The first entry is held for review; the rest are unacknowledged, so the disk keeps them.
    expect(statuses(recovered.payload.acknowledgements)).toEqual(["held"]);
    expect(recovered.payload.acknowledgements[0]).toMatchObject({ error: { code: "TERMINAL_REVOKED" } });
    expect(recovered.payload.committedThroughSequence).toBe(0);
    const kept = await prisma.offlineJournalReview.findMany({ where: { tenantId: c.fx.tenantId } });
    expect(kept.map((k) => [k.recordId, k.outcome])).toEqual([[commands[0]!.payload.commandId, "held"]]);
    // Re-uploading is answered the same way: still held, nothing committed, nothing removed.
    const again = await journal.sync(c.owner, branch(c), request(c, { staffSignIns: [cashierIn], commands }));
    expect(statuses(again.payload.acknowledgements)).toEqual(["held"]);
    expect(await prisma.offlineJournalReview.findFirstOrThrow({ where: { tenantId: c.fx.tenantId } })).toMatchObject({ attempts: 2 });
    // Nothing became a sale or moved stock on its own.
    expect(await effects(c)).toMatchObject({ sales: 0, saleLedger: 0 });
    expect(await onHand(c.batches.main)).toBe(20);
  });

  it("questionable evidence — a forked journal at an accepted place — is kept for review, not accepted", async () => {
    const c = await counter({ main: 10 });
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    const open = j.open(cashierIn, 0);
    const late = j.sale(cashierIn, [[c.batches.main, 1]], { occurredAt: c.grant.expiresAt });
    const after = c.grant.expiresAt + hour;
    await sync(c, { staffSignIns: [cashierIn], commands: [open, late] }, after);
    // A restored backup signs a different record at the same place.
    const other = j.tamper(late, { commandId: randomUUID(), lines: [{ ...late.payload.lines[0]!, quantity: 2 }] });
    expect((await sync(c, { commands: [other] }, after)).payload.acknowledgements[0]).toMatchObject({ sequence: 2, status: "rejected" });

    const rows = await prisma.offlineJournalReview.findMany({ where: { tenantId: c.fx.tenantId, sequence: 2 } });
    expect(rows.map((r) => r.recordId).sort()).toEqual([late.payload.commandId, other.payload.commandId].sort());
    const reviewId = rows.find((r) => r.recordId === late.payload.commandId && r.outcome === "rejected")!.id;
    // The manager can't simply pick one: it goes to journal recovery.
    expect((await reviews.detail(c.fx.tenantId, branch(c), reviewId)).settleBlocker).toMatchObject({ code: "forked" });
    expect(await effects(c)).toMatchObject({ sales: 0 });
  });
});
