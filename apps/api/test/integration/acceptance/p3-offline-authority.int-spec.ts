import { randomUUID } from "node:crypto";
import { acceptedJournalState, issueOfflineAuthority } from "../../../src/terminals/offline-authority-issuance";
import {
  access,
  counter,
  offlineJournal,
  onHand,
  prisma,
  sales,
  signer,
  stock,
  sync,
  trust,
  type Counter,
} from "../offline-counter.kit";
import { branch, statuses } from "./acceptance.kit";

/**
 * P3 #49 acceptance: what offline authority does — and must not do — to the branch's stock.
 * Designation, issuance, renewal, an outage with its journal, expiry and revocation reserve nothing
 * and take nothing from online availability; existing business reservations stay correct; snapshots
 * taken while sales and reservations commit are coherent; a revoked counter keeps its evidence.
 */
afterAll(async () => {
  await prisma.$disconnect();
});

const renew = (c: Counter) =>
  issueOfflineAuthority(prisma as never, access, {
    signer,
    defaultVatRatePercent: 18,
    authenticate: async () => ({ identity: c.identity, commandId: randomUUID() }),
    readState: acceptedJournalState,
  });

/**
 * Under contention, issuance refuses with the retryable TEMPORARILY_UNAVAILABLE (a serialization
 * conflict) rather than sign a mixed read; the counter retries, and so does this.
 */
async function renewRetrying(c: Counter): Promise<Awaited<ReturnType<typeof renew>>> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await renew(c);
    } catch (error) {
      const code = (error as { response?: { code?: string } }).response?.code;
      if (code !== "TEMPORARILY_UNAVAILABLE" || attempt >= 20) throw error;
    }
  }
}

const reservations = (c: Counter) => prisma.stockReservation.findMany({ where: { tenantId: c.fx.tenantId } });
const available = (snapshot: Awaited<ReturnType<typeof renew>>["snapshot"], batchId: string) =>
  snapshot.payload.lines.find((l) => l.batchId === batchId)?.availableQuantity;

/** One online sale across batches, all lines in one transaction. */
const onlineSale = (c: Counter, lines: Array<[string, number]>) =>
  sales.checkout(c.fx.tenantId, branch(c), c.owner.userId, [], {
    items: lines.map(([batchId, qty]) => ({ productId: c.fx.productId, batchId, qty, unitPrice: "15.50" })),
  } as never, undefined);

/** A business reservation, as an approved transfer makes one. */
const reserve = (c: Counter, lines: Array<[string, number]>) =>
  prisma.$transaction((tx) =>
    stock.reserve(
      tx,
      { tenantId: c.fx.tenantId, branchId: branch(c), userId: c.owner.userId, sourceType: "transfer", sourceId: randomUUID() },
      lines.map(([batchId, qty]) => ({ productId: c.fx.productId, batchId, qty })),
    ),
  );

describe("P3: offline authority reserves nothing and leaves online stock whole", () => {
  it("designation, issuance, renewals, an outage and its journal create no reservation; online can still sell every available unit", async () => {
    // counter() designates the counter and issues its first pair.
    const c = await counter({ main: 20 });
    expect(await reservations(c)).toEqual([]);
    expect(c.snapshot.lines.find((l) => l.batchId === c.batches.main)!.availableQuantity).toBe(20);

    // An existing business reservation: the snapshot excludes it, and it stays exactly as it was.
    await reserve(c, [[c.batches.main!, 4]]);
    const business = await reservations(c);
    expect(business).toHaveLength(1);
    const renewed = await renew(c);
    expect(available(renewed.snapshot, c.batches.main!)).toBe(16);
    await renew(c);
    expect(await reservations(c)).toEqual(business);

    // An outage: the counter sells 2 offline, then its journal arrives. Still nothing reserved.
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    const response = await sync(c, { staffSignIns: [cashierIn], commands: [j.open(cashierIn, 0), j.sale(cashierIn, [[c.batches.main!, 2]])] });
    expect(statuses(response.payload.acknowledgements)).toEqual(["committed", "committed"]);
    expect(await reservations(c)).toEqual(business);
    expect(await onHand(c.batches.main!)).toBe(18);

    // Expiry has no server side: the grant's end is a signed time the counter enforces, with no
    // reservation behind it to reclaim (journals after expiry: `offline-journal.int-spec.ts`).

    // Online keeps the full normal availability: 18 on hand − 4 promised = 14 sell, the 15th does not.
    await onlineSale(c, [[c.batches.main!, 14]]);
    expect(await onHand(c.batches.main!)).toBe(4);
    await expect(onlineSale(c, [[c.batches.main!, 1]])).rejects.toBeDefined();
    expect(await reservations(c)).toEqual(business);
  });

  it("snapshots taken while multi-batch sales and reservations commit are coherent: each sees every change whole or not at all", async () => {
    const c = await counter({ a: 30, b: 30 });
    const [a, b] = [c.batches.a!, c.batches.b!];
    // Every change moves both batches by the same amount in one transaction, so any coherent read
    // shows the two batches equal. A snapshot that read one batch before a change and the other
    // after it would show them apart.
    const work: Array<Promise<unknown>> = [];
    const snapshots: Array<Promise<Awaited<ReturnType<typeof renew>>>> = [];
    for (let i = 0; i < 4; i += 1) {
      work.push(onlineSale(c, [[a, 1], [b, 1]]));
      snapshots.push(renewRetrying(c));
      work.push(reserve(c, [[a, 2], [b, 2]]));
      snapshots.push(renewRetrying(c));
    }
    await Promise.all(work);
    const issued = await Promise.all(snapshots);
    for (const { snapshot } of issued) {
      const [qa, qb] = [available(snapshot, a)!, available(snapshot, b)!];
      expect(qa).toBe(qb);
      expect(qa).toBeGreaterThanOrEqual(30 - 4 * 3);
      expect(qa).toBeLessThanOrEqual(30);
      // Last-known and nothing more: no journal yet, so the watermark stays at its start.
      expect(snapshot.payload).toMatchObject({ includedThroughSequence: 0, includedThroughHash: null });
    }
    // Each issuance is its own version.
    expect(new Set(issued.map((p) => p.snapshot.payload.snapshotVersion)).size).toBe(issued.length);
    // After everything committed: 30 − 4 sold − 8 promised = 18 in each batch.
    const last = await renew(c);
    expect([available(last.snapshot, a), available(last.snapshot, b)]).toEqual([18, 18]);
  });

  it("a revoked counter gets no renewal, keeps every issued pair as evidence, and leaves no reservation to reclaim", async () => {
    const c = await counter({ main: 20 });
    await renew(c);
    const issuedBefore = await prisma.offlineStockSnapshot.count({ where: { enrollmentId: c.identity.enrollmentId } });
    expect(issuedBefore).toBe(2);
    await prisma.$transaction((tx) => trust.revokeEnrollment(tx, c.owner, branch(c), c.identity.enrollmentId, "Stolen from the counter"));

    await expect(renew(c)).rejects.toMatchObject({ response: { code: expect.any(String) } });
    // Its evidence stays: both pairs, unchanged, and no reservation was ever made to release.
    expect(await prisma.offlineStockSnapshot.count({ where: { enrollmentId: c.identity.enrollmentId } })).toBe(issuedBefore);
    expect(await reservations(c)).toEqual([]);
    // Online availability was never touched: every unit sells online.
    await onlineSale(c, [[c.batches.main!, 20]]);
    expect(await onHand(c.batches.main!)).toBe(0);
  });
});
