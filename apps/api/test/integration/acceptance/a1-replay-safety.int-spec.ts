import { randomUUID } from "node:crypto";
import { commandText, sha256 } from "../../../src/terminals/terminal-wire";
import { counter, offlineJournal, onHand, prisma, saleAck, sync } from "../offline-counter.kit";
import { effects, statuses } from "./acceptance.kit";

/**
 * P5 #51 acceptance box A1 — fixture run against `POST /api/v1/terminals/offline-journal/sync`
 * (OfflineJournalService.sync): duplicate, reordered and modified uploads, a response lost after
 * commit, and concurrent retries give one receipt and one business effect; a changed digest fails.
 */
afterAll(async () => {
  await prisma.$disconnect();
});

describe("A1: one receipt and one business effect however the journal arrives", () => {
  it("a duplicate upload, and a resend after the response was lost post-commit, return the original receipts", async () => {
    const c = await counter({ main: 20 });
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    const commands = [j.open(cashierIn, 0), j.sale(cashierIn, [[c.batches.main, 3]]), j.sale(cashierIn, [[c.batches.main, 2]])];

    const first = await sync(c, { staffSignIns: [cashierIn], commands });
    expect(statuses(first.payload.acknowledgements)).toEqual(["committed", "committed", "committed"]);
    const once = await effects(c);
    expect(once).toMatchObject({ sales: 2, payments: 2, saleLedger: 2, receipts: 3, shifts: 1 });
    expect(await onHand(c.batches.main)).toBe(15);

    // The response never reached the counter (committed, then lost): it resends the same bytes.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const resend = await sync(c, { staffSignIns: [cashierIn], commands });
      expect(statuses(resend.payload.acknowledgements)).toEqual(["duplicate", "duplicate", "duplicate"]);
      for (const i of [1, 2]) {
        const original = saleAck(first.payload.acknowledgements[i]!);
        expect(saleAck(resend.payload.acknowledgements[i]!)).toEqual({ ...original, status: "duplicate" });
      }
      expect(resend.payload.committedThroughSequence).toBe(first.payload.committedThroughSequence);
      expect(resend.payload.committedThroughHash).toBe(first.payload.committedThroughHash);
    }
    expect(await effects(c)).toEqual(once);
    expect(await onHand(c.batches.main)).toBe(15);
  });

  it("a reordered upload is applied in sequence order, a gap is held, and each entry takes effect once", async () => {
    const c = await counter({ main: 20 });
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    const [one, two, three, four] = [j.open(cashierIn, 0), j.sale(cashierIn, [[c.batches.main, 1]]),
      j.sale(cashierIn, [[c.batches.main, 2]]), j.sale(cashierIn, [[c.batches.main, 3]])];

    const partial = await sync(c, { staffSignIns: [cashierIn], commands: [four, three, one] });
    // Processing stops at the first held entry; 4 gets no acknowledgement and stays queued.
    expect(partial.payload.acknowledgements.map((a) => [a.sequence, a.status])).toEqual([[1, "committed"], [3, "held"]]);
    expect(partial.payload.acknowledgements[1]).toMatchObject({ error: { code: "SEQUENCE_GAP" } });
    expect(partial.payload.committedThroughSequence).toBe(1);
    expect(await onHand(c.batches.main)).toBe(20);

    const rest = await sync(c, { commands: [three, four, two, one] });
    expect(rest.payload.acknowledgements.map((a) => [a.sequence, a.status]))
      .toEqual([[1, "duplicate"], [2, "committed"], [3, "committed"], [4, "committed"]]);
    expect(rest.payload.committedThroughSequence).toBe(4);
    expect(rest.payload.committedThroughHash).toBe(sha256(commandText(four.payload)));
    expect(await effects(c)).toMatchObject({ sales: 3, payments: 3, saleLedger: 3, receipts: 4 });
    expect(await onHand(c.batches.main)).toBe(14);
  });

  it("a modified upload (same entry, changed digest) fails and is kept for review; the original still stands once", async () => {
    const c = await counter({ main: 20 });
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    const open = j.open(cashierIn, 0);
    const sale = j.sale(cashierIn, [[c.batches.main, 2]]);
    const accepted = await sync(c, { staffSignIns: [cashierIn], commands: [open, sale] });
    const before = await effects(c);

    // Same command ID and sequence, different content: the record digest no longer matches.
    const changed = j.tamper(sale, { lines: [{ ...sale.payload.lines[0]!, quantity: 1 }] });
    expect(sha256(commandText(changed.payload))).not.toBe(sha256(commandText(sale.payload)));
    const refused = await sync(c, { commands: [changed] });
    expect(refused.payload.acknowledgements[0]).toMatchObject({ status: "rejected", error: { code: "REPLAY_CONFLICT" } });
    // Same place, other command ID.
    const respun = await sync(c, { commands: [j.tamper(sale, { commandId: randomUUID() })] });
    expect(respun.payload.acknowledgements[0]).toMatchObject({ status: "rejected", error: { code: "REPLAY_CONFLICT" } });
    expect(respun.payload.committedThroughSequence).toBe(2);

    expect(await prisma.offlineJournalReview.count({ where: { tenantId: c.fx.tenantId, outcome: "conflict" } })).toBe(2);
    expect(await effects(c)).toEqual(before);
    expect(await onHand(c.batches.main)).toBe(18);
    const replay = await sync(c, { commands: [sale] });
    expect(saleAck(replay.payload.acknowledgements[0]!)).toMatchObject({
      status: "duplicate", saleId: saleAck(accepted.payload.acknowledgements[1]!).saleId,
    });
  });

  it("concurrent retries of one upload commit once and all answer with the same receipt", async () => {
    const c = await counter({ main: 20 });
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    const commands = [j.open(cashierIn, 0), j.sale(cashierIn, [[c.batches.main, 4]]), j.sale(cashierIn, [[c.batches.main, 1]])];

    const results = await Promise.all(Array.from({ length: 6 }, () => sync(c, { staffSignIns: [cashierIn], commands })));
    for (const i of [1, 2]) {
      const acks = results.map((r) => saleAck(r.payload.acknowledgements[i]!));
      expect(new Set(acks.map((a) => a.saleId)).size).toBe(1);
      expect(new Set(acks.map((a) => a.committedAt)).size).toBe(1);
      expect(acks.filter((a) => a.status === "committed")).toHaveLength(1);
    }
    expect(new Set(results.map((r) => r.payload.committedThroughHash)).size).toBe(1);
    expect(await effects(c)).toMatchObject({ sales: 2, payments: 2, saleLedger: 2, receipts: 3, shifts: 1 });
    expect(await onHand(c.batches.main)).toBe(15);
  });
});
