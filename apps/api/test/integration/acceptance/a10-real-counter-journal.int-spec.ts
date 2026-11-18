import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Signed, SyncResponse } from "@pharmaceylon/shared";
import { acceptedJournalState, issueOfflineAuthority } from "../../../src/terminals/offline-authority-issuance";
import { ApiError } from "../../../../pos-desktop/src/main/api/api-client";
import type { SecretProtector } from "../../../../pos-desktop/src/main/db/key-store";
import { migrations } from "../../../../pos-desktop/src/main/db/migrations";
import { DeviceKey } from "../../../../pos-desktop/src/main/device/device-key";
import { DeviceStore } from "../../../../pos-desktop/src/main/device/device-store";
import { openLocalStore, type LocalStore } from "../../../../pos-desktop/src/main/local-store";
import { PinStore } from "../../../../pos-desktop/src/main/staff/pin-store";
import { installOfflineAuthority } from "../../../../pos-desktop/src/main/terminal/offline-authority";
import { OfflineCounterService } from "../../../../pos-desktop/src/main/terminal/offline-counter";
import { OfflineJournalWriter } from "../../../../pos-desktop/src/main/terminal/offline-journal-writer";
import {
  createOfflineJournalSync,
  readJournalSyncView,
} from "../../../../pos-desktop/src/main/terminal/offline-journal-sync";
import { OfflineSaleService } from "../../../../pos-desktop/src/main/terminal/offline-sale";
import { TrustedClock } from "../../../../pos-desktop/src/main/terminal/trusted-clock";
import { access, counter, journal, onHand, prisma, server, signer, type Counter } from "../offline-counter.kit";
import { effects, onlineSale, reviewSet, statuses } from "./acceptance.kit";

/**
 * P5 #51 / P3 #49 acceptance against a journal written by the real P4 #50 offline checkout.
 *
 * The other acceptance specs sign fixture journals (`offline-counter.kit`). Here the desktop's
 * own main-process services write the journal: the encrypted local store with its real
 * migrations, the installed server-signed authority, personal PINs, the trusted clock, the
 * shift and sale services and the card attempt records. The desktop's own uploader
 * (`offline-journal-sync`) sends it, and the server's real intake replays it into Postgres.
 *
 * Covered here on real journals: A1 (duplicate, reordered, concurrent and modified uploads, a
 * response lost after commit, reconnect loops), A2 (partial partition), A3's watermark and
 * snapshot block (manager resolution is `a3-pending-posting`), staff switch and shift handover,
 * and P3's rebase of the next authority over the accepted journal. Only the HTTP hop and the
 * Windows process are left out: the uploader calls the intake directly, through JSON.
 */
const protector: SecretProtector = {
  isAvailable: () => true,
  protect: (p) => Buffer.from(p),
  unprotect: (b) => b.toString(),
};
const CASHIER_PIN = "1234";
const MANAGER_PIN = "5678";
const UP0 = 3_600_000;

type Desktop = {
  local: LocalStore;
  dir: string;
  staff: OfflineCounterService;
  sale: OfflineSaleService;
  clock: TrustedClock;
  advance: (ms: number) => void;
  trusted: () => number;
};

/** The open local store, set as soon as it opens so a failed setup is cleaned up too. */
let opened: { local: LocalStore; dir: string } | null = null;

afterEach(() => {
  if (!opened) return;
  opened.local.db.close();
  rmSync(opened.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  opened = null;
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Enrolls the desktop's own key, then sets the counter up as it is at the start of an outage. */
async function realCounter(stock: Record<string, number>): Promise<{ c: Counter; key: DeviceKey; d: Desktop }> {
  const key = DeviceKey.generate();
  const c = await counter(
    stock,
    {
      externalCard: true,
      device: {
        keyId: key.keyId,
        device: {
          publicKeyHex: key.publicKeyHex,
          // The desktop key signs under its own key ID, which enrollment pinned.
          sign: (payload, _keyId, purpose = "command") => key.sign(payload, purpose as never),
        },
      },
    },
  );
  const dir = mkdtempSync(join(tmpdir(), "pos-real-journal-"));
  const local = openLocalStore(dir, protector, migrations);
  opened = { local, dir };
  const { identity } = c;
  const till = { registerId: c.grant.registerId, tillId: c.grant.tillId };
  // Saved as the desktop saves an enrollment, then activated as the server confirmed it.
  const device = new DeviceStore(local.db);
  device.savePending({
    apiBaseUrl: "http://127.0.0.1:3000",
    identity,
    branchName: "Main",
    branchCode: "",
    ...till,
    counterLabel: "Front",
    label: "PC",
    key,
    enrolledByUserId: c.owner.userId,
    enrolledByName: "Owner",
    now: new Date(),
  });
  device.setStatus("active", new Date());

  let up = UP0;
  let wall = Date.now();
  const issuedAt = c.grant.issuedAt;
  const trusted = () => issuedAt + (up - UP0);
  const advance = (ms: number) => {
    up += ms;
    wall += ms;
  };
  const clock = new TrustedClock({ db: local.db, uptimeMs: () => up, wallMs: () => wall });
  // The pair exactly as the server issued and signed it.
  expect(
    installOfflineAuthority(local.db, c.issued, {
      identity,
      ...till,
      signer: { keyId: signer.keyId, publicKey: server.publicKey },
      trustedNow: trusted(),
    }),
  ).toBe("installed");
  clock.observe(issuedAt, "snapshot");
  const pins = new PinStore(local.db);
  for (const [person, pin, name] of [
    [c.cashier, CASHIER_PIN, "Nimal"],
    [c.manager, MANAGER_PIN, "Dilani"],
  ] as const)
    pins.save({
      staffUserId: person.userId, pin, staffName: name, role: null,
      enrollmentId: identity.enrollmentId, pinVersion: 1, now: new Date(wall),
    });
  const writer = new OfflineJournalWriter({ db: local.db, now: () => new Date(wall) });
  advance(10_000);
  writer.ensureOfflineOutageSession(identity.enrollmentId, trusted());
  const staff = new OfflineCounterService({
    db: local.db,
    device,
    pins,
    journal: writer,
    clock,
    mode: { view: () => ({ mode: "offline", reason: null }) as never },
  });
  const sale = new OfflineSaleService({ db: local.db, counter: staff, journal: writer });
  return { c, key, d: { local, dir, staff, sale, clock, advance, trusted } };
}

/** The desktop uploader, with HTTP replaced by a direct call to the server's intake. */
function uploader(c: Counter, d: Desktop) {
  const sent: unknown[] = [];
  const replies: Signed<SyncResponse>[] = [];
  const sync = createOfflineJournalSync({
    db: d.local.db,
    terminal: { current: () => ({ identity: c.identity }) as never },
    signer: { keyId: signer.keyId, publicKey: server.publicKey },
    // As the desktop wires it: a verified reply's signed server time anchors the trusted clock.
    clock: d.clock,
    report: (error) => {
      throw error;
    },
    api: {
      request: (async (_method: string, _path: string, options: { body: unknown }) => {
        // Through JSON, as over the wire.
        const body = JSON.parse(JSON.stringify(options.body)) as unknown;
        sent.push(body);
        const reply = await journal.sync(c.cashier, c.fx.mainBranchId, body, Math.max(Date.now(), d.trusted() + 1_000));
        replies.push(reply);
        return JSON.parse(JSON.stringify(reply)) as unknown;
      }) as never,
    },
  });
  return { sync, sent, replies };
}

/** What the uploader would send, captured with the network still down. */
async function pendingUpload(c: Counter, d: Desktop) {
  let body: unknown;
  const down = createOfflineJournalSync({
    db: d.local.db,
    terminal: { current: () => ({ identity: c.identity }) as never },
    signer: { keyId: signer.keyId, publicKey: server.publicKey },
    report: () => {},
    api: {
      request: (async (_method: string, _path: string, options: { body: unknown }) => {
        body = JSON.parse(JSON.stringify(options.body)) as unknown;
        // What the desktop's API client throws when the server can't be reached.
        throw new ApiError(0, "NETWORK", "network unreachable");
      }) as never,
    },
  });
  await down.tick({ force: true });
  return body as { staffSignIns: unknown[]; commands: Array<Signed<{ sequence: number; kind: string } & Record<string, unknown>>> } & Record<string, unknown>;
}

const openShiftCash = (d: Desktop) =>
  (
    d.local.db.prepare("SELECT expected_cash_minor FROM till_shift WHERE state = 'open'").get() as {
      expected_cash_minor: number;
    }
  ).expected_cash_minor;

describe("A10: a journal written by the real P4 offline checkout replays once on the server", () => {
  it("shift open, a cash sale, a card-and-cash sale and shift close: committed once, retries are duplicates, the next authority rebases on it", async () => {
    const { c, d } = await realCounter({ main: 20 });
    const line = c.snapshot.lines.find((l) => l.batchId === c.batches.main)!;
    const items = (quantity: number) => [{ snapshotLineId: line.snapshotLineId, quantity }];

    // The counter, offline: sign in with a personal PIN and open the shift.
    d.staff.signIn(c.cashier.userId, CASHIER_PIN);
    d.staff.openShift(CASHIER_PIN, { totalMinor: 10_000, lines: [] });
    d.advance(5_000);
    const cash = d.sale.commit({ checkoutDraftId: randomUUID(), items: items(2), cashTenderedMinor: 50_000 });
    d.advance(5_000);
    // A card on the external machine for part, cash for the rest.
    const draft = randomUUID();
    const { attemptId } = d.sale.prepareCard({ checkoutDraftId: draft, items: items(3), amountMinor: 5_000 });
    d.advance(15_000);
    d.sale.recordCardOutcome({
      attemptId,
      outcome: { kind: "approved", reference: "RRN-A10", approvalCode: "A10OK", approvedAt: d.trusted() },
    });
    d.advance(2_000);
    const card = d.sale.commit({ checkoutDraftId: draft, items: items(3), cashTenderedMinor: 10_000 });
    d.advance(60_000);
    const expected = openShiftCash(d);
    expect(expected).toBe(10_000 + cash.totalMinor + (card.totalMinor - 5_000));
    d.staff.closeShift({ totalMinor: expected, lines: [] });

    // Back online: the desktop's own uploader sends what the desktop wrote.
    const up = uploader(c, d);
    await up.sync.tick({ force: true });
    const acks = up.replies.flatMap((r) => r.payload.acknowledgements);
    expect(acks.map((a) => [a.sequence, a.status])).toEqual([
      [1, "committed"],
      [2, "committed"],
      [3, "committed"],
      [4, "committed"],
    ]);
    const once = await effects(c);
    expect(once).toMatchObject({ sales: 2, payments: 3, saleLedger: 2, shifts: 1 });
    expect(await onHand(c.batches.main)).toBe(15);

    // The sales are the counter's sales, one per journal entry, with the card's reference.
    const saved = await prisma.sale.findMany({
      where: { tenantId: c.fx.tenantId },
      include: { payments: true },
      orderBy: { createdAt: "asc" },
    });
    expect(saved.map((s) => s.offlineCommandId).sort()).toEqual([cash.saleCommandId, card.saleCommandId].sort());
    // Under the receipt numbers the counter printed.
    expect(saved.map((s) => [s.offlineCommandId, s.invoiceNo]).sort()).toEqual(
      [
        [cash.saleCommandId, cash.receiptNumber],
        [card.saleCommandId, card.receiptNumber],
      ].sort(),
    );
    const cardSale = saved.find((s) => s.offlineCommandId === card.saleCommandId)!;
    expect(cardSale.payments.find((p) => p.method === "card")).toMatchObject({ reference: "RRN-A10" });
    // The shift closed on the server with the drawer the counter counted, and no variance.
    const shift = await prisma.tillShift.findFirstOrThrow({ where: { tenantId: c.fx.tenantId } });
    expect(shift).toMatchObject({ closingCashCountMinor: expected, expectedCashMinor: expected });
    expect(shift.closedAt).not.toBeNull();
    // The card attempt's evidence arrived beside the journal, linked to its sale.
    const evidence = await prisma.offlineSupportRecord.findMany({
      where: { tenantId: c.fx.tenantId, attemptId },
    });
    expect(evidence.map((r) => r.saleCommandId)).toContain(card.saleCommandId);

    // The desktop agrees: everything it wrote is accepted, nothing waits.
    expect(readJournalSyncView(d.local.db, c.identity.enrollmentId)).toMatchObject({
      recorded: 4,
      accepted: 4,
      waiting: 0,
      refused: 0,
      issue: null,
    });
    // The verified reply's signed server time now anchors the counter's trusted clock.
    const head = up.replies.at(-1)!.payload;
    expect(d.clock.now()).toMatchObject({ trusted: true, source: "sync_response" });
    expect((d.clock.now() as { anchoredAt: number }).anchoredAt).toBeGreaterThanOrEqual(head.serverTime);

    // A response lost after commit: the same bytes again give the original receipts, once.
    const resent = [];
    for (const body of up.sent) resent.push(await journal.sync(c.cashier, c.fx.mainBranchId, body, Date.now() + 120_000));
    expect(statuses(resent.flatMap((r) => r.payload.acknowledgements))).toEqual([
      "duplicate",
      "duplicate",
      "duplicate",
      "duplicate",
    ]);
    // And the desktop's next look sends nothing new.
    await up.sync.tick({ force: true });
    expect(await effects(c)).toEqual(once);
    expect(await onHand(c.batches.main)).toBe(15);

    // P3: the next authority is rebased over the accepted journal: its head, and the stock it used.
    const renewal = await issueOfflineAuthority(prisma as never, access, {
      signer,
      defaultVatRatePercent: 18,
      authenticate: async () => ({ identity: c.identity, commandId: randomUUID() }),
      readState: acceptedJournalState,
    });
    expect(renewal.snapshot.payload).toMatchObject({
      includedThroughSequence: 4,
      includedThroughHash: head.committedThroughHash,
    });
    expect(renewal.snapshot.payload.lines.find((l) => l.batchId === c.batches.main)).toMatchObject({
      availableQuantity: 15,
      stockReviewRequired: false,
    });
    // Numbering resumes one past the two receipts the counter used, under the same prefix.
    expect(renewal.grant.payload.receiptNumbering).toEqual({
      prefix: c.grant.receiptNumbering.prefix,
      nextNumber: c.grant.receiptNumbering.nextNumber + 2,
    });
  });

  it("A1 on a real journal: reordered, concurrent and modified uploads give one receipt and one business effect", async () => {
    const { c, key, d } = await realCounter({ main: 20 });
    const line = c.snapshot.lines.find((l) => l.batchId === c.batches.main)!;
    const items = (quantity: number) => [{ snapshotLineId: line.snapshotLineId, quantity }];
    d.staff.signIn(c.cashier.userId, CASHIER_PIN);
    d.staff.openShift(CASHIER_PIN, { totalMinor: 0, lines: [] });
    d.advance(5_000);
    d.sale.commit({ checkoutDraftId: randomUUID(), items: items(1), cashTenderedMinor: 50_000 });
    d.advance(5_000);
    d.sale.commit({ checkoutDraftId: randomUUID(), items: items(2), cashTenderedMinor: 50_000 });
    d.advance(5_000);
    d.sale.commit({ checkoutDraftId: randomUUID(), items: items(3), cashTenderedMinor: 50_000 });
    d.advance(5_000);
    const body = await pendingUpload(c, d);
    expect(body.commands.map((e) => e.payload.sequence)).toEqual([1, 2, 3, 4]);
    const now = () => Math.max(Date.now(), d.trusted() + 1_000);
    const [one, two, three, four] = body.commands;

    // Reordered, with a gap: processing stops at the first held entry, nothing after it applies.
    const partial = await journal.sync(c.cashier, c.fx.mainBranchId, { ...body, commands: [four, three, one] }, now());
    expect(partial.payload.acknowledgements.map((a) => [a.sequence, a.status])).toEqual([[1, "committed"], [3, "held"]]);
    expect(partial.payload.acknowledgements[1]).toMatchObject({ error: { code: "SEQUENCE_GAP" } });
    expect(await onHand(c.batches.main)).toBe(20);

    // Concurrent retries of the whole journal: each entry commits once, every answer agrees.
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        journal.sync(c.cashier, c.fx.mainBranchId, { ...body, commands: [three, two, four, one] }, now()),
      ),
    );
    for (const sequence of [2, 3, 4]) {
      const acks = results.map((r) => r.payload.acknowledgements.find((a) => a.sequence === sequence)!);
      expect(acks.filter((a) => a.status === "committed")).toHaveLength(1);
      expect(new Set(acks.map((a) => ("saleId" in a ? a.saleId : null))).size).toBe(1);
    }
    const once = await effects(c);
    expect(once).toMatchObject({ sales: 3, payments: 3, saleLedger: 3, receipts: 4, shifts: 1 });
    expect(await onHand(c.batches.main)).toBe(14);

    // The desktop reconnects: it sends its journal, and every entry is already there.
    const up = uploader(c, d);
    await up.sync.tick({ force: true });
    expect(statuses(up.replies.flatMap((r) => r.payload.acknowledgements))).toEqual([
      "duplicate",
      "duplicate",
      "duplicate",
      "duplicate",
    ]);
    // The outage's network failure no longer shows once the server has answered.
    expect(readJournalSyncView(d.local.db, c.identity.enrollmentId)).toMatchObject({
      accepted: 4,
      waiting: 0,
      refused: 0,
      issue: null,
    });

    // Modified: the same entry, re-signed by the counter's own key with changed content, fails.
    const sale = two!.payload as unknown as { lines: Array<{ quantity: number }> };
    const changed = key.sign({ ...two!.payload, lines: [{ ...sale.lines[0]!, quantity: 9 }] }, "command");
    const refused = await journal.sync(c.cashier, c.fx.mainBranchId, { ...body, commands: [changed] }, now());
    expect(refused.payload.acknowledgements[0]).toMatchObject({ status: "rejected", error: { code: "REPLAY_CONFLICT" } });
    expect(await effects(c)).toEqual(once);
    expect(await onHand(c.batches.main)).toBe(14);
  });

  it("A2 and A3 on a real journal: 10 last known, 7 sold online, 5 sold offline; the next snapshot keeps the block", async () => {
    const { c, d } = await realCounter({ partition: 10, unrelated: 20 });
    const snapshotLine = (batchId: string) => c.snapshot.lines.find((l) => l.batchId === batchId)!;
    expect(snapshotLine(c.batches.partition!).availableQuantity).toBe(10);

    // Online, while the counter is cut off.
    await onlineSale(c, c.batches.partition, 7);
    expect(await onHand(c.batches.partition!)).toBe(3);

    // Offline, on the counter: 5 from the partition batch (it last knew 10), 2 from unrelated stock.
    d.staff.signIn(c.cashier.userId, CASHIER_PIN);
    d.staff.openShift(CASHIER_PIN, { totalMinor: 0, lines: [] });
    d.advance(5_000);
    const short = d.sale.commit({
      checkoutDraftId: randomUUID(),
      items: [{ snapshotLineId: snapshotLine(c.batches.partition!).snapshotLineId, quantity: 5 }],
      cashTenderedMinor: 100_000,
    });
    d.advance(5_000);
    const fine = d.sale.commit({
      checkoutDraftId: randomUUID(),
      items: [{ snapshotLineId: snapshotLine(c.batches.unrelated!).snapshotLineId, quantity: 2 }],
      cashTenderedMinor: 100_000,
    });
    d.advance(5_000);

    const up = uploader(c, d);
    await up.sync.tick({ force: true });
    const acks = up.replies.flatMap((r) => r.payload.acknowledgements);
    expect(statuses(acks)).toEqual(["committed", "committed", "committed"]);

    // The offline sale and its payment are kept as made; its stock waits on a shortfall case.
    const shortAck = acks.find((a) => a.commandId === short.saleCommandId)!;
    expect(shortAck).toMatchObject({ stockPosting: "pending_reconciliation", reconciliationCaseId: expect.any(String) });
    const row = await prisma.sale.findFirstOrThrow({
      where: { tenantId: c.fx.tenantId, offlineCommandId: short.saleCommandId },
      include: { payments: true },
    });
    expect(row.grandTotal.mul(100).toNumber()).toBe(short.totalMinor);
    expect(row.payments.map((p) => p.method)).toEqual(["cash"]);
    expect(await onHand(c.batches.partition!)).toBe(3);
    const discrepancy = await prisma.offlineStockDiscrepancy.findUniqueOrThrow({
      where: { id: (shortAck as { reconciliationCaseId: string }).reconciliationCaseId },
      include: { lines: true, blocks: true },
    });
    expect(discrepancy.lines).toEqual([
      expect.objectContaining({ batchId: c.batches.partition, soldQuantity: 5, availableQuantityAtSync: 3, shortfallQuantity: 2 }),
    ]);
    expect(discrepancy.blocks.map((b) => [b.batchId, b.releasedAt])).toEqual([[c.batches.partition, null]]);
    // Only the affected batch: the unrelated sale posted, and online it still sells.
    expect(acks.find((a) => a.commandId === fine.saleCommandId)).toMatchObject({ stockPosting: "posted" });
    expect(await onHand(c.batches.unrelated!)).toBe(18);
    expect(await reviewSet(c)).toEqual([c.batches.partition]);
    await expect(onlineSale(c, c.batches.partition, 1)).rejects.toMatchObject({ response: { code: "BATCH_STOCK_REVIEW" } });
    expect(readJournalSyncView(d.local.db, c.identity.enrollmentId)).toMatchObject({ accepted: 3, waiting: 0, refused: 0 });

    // A3 / P3: the next authority advances past the accepted entries, and keeps the block.
    const renewal = await issueOfflineAuthority(prisma as never, access, {
      signer,
      defaultVatRatePercent: 18,
      authenticate: async () => ({ identity: c.identity, commandId: randomUUID() }),
      readState: acceptedJournalState,
    });
    expect(renewal.snapshot.payload).toMatchObject({
      includedThroughSequence: 3,
      includedThroughHash: up.replies.at(-1)!.payload.committedThroughHash,
    });
    const next = (batchId: string) => renewal.snapshot.payload.lines.find((l) => l.batchId === batchId);
    expect(next(c.batches.partition!)).toMatchObject({ stockReviewRequired: true });
    expect(next(c.batches.unrelated!)).toMatchObject({ availableQuantity: 18, stockReviewRequired: false });
  });

  it("staff switch and shift handover on a real journal: each person's shift, sales and cash count, one outage", async () => {
    const { c, d } = await realCounter({ main: 20 });
    const line = c.snapshot.lines.find((l) => l.batchId === c.batches.main)!;
    const items = (quantity: number) => [{ snapshotLineId: line.snapshotLineId, quantity }];

    // The cashier's shift.
    d.staff.signIn(c.cashier.userId, CASHIER_PIN);
    d.staff.openShift(CASHIER_PIN, { totalMinor: 5_000, lines: [] });
    d.advance(5_000);
    const first = d.sale.commit({ checkoutDraftId: randomUUID(), items: items(1), cashTenderedMinor: 50_000 });
    d.advance(5_000);
    const cashierCount = openShiftCash(d);
    d.staff.closeShift({ totalMinor: cashierCount, lines: [] });
    d.advance(5_000);
    // The manager takes over the till with the counted drawer.
    d.staff.signIn(c.manager.userId, MANAGER_PIN);
    d.staff.openShift(MANAGER_PIN, { totalMinor: cashierCount, lines: [] });
    d.advance(5_000);
    const second = d.sale.commit({ checkoutDraftId: randomUUID(), items: items(2), cashTenderedMinor: 50_000 });
    d.advance(5_000);
    const managerCount = openShiftCash(d) - 100;
    d.staff.closeShift({ totalMinor: managerCount, lines: [] }, { varianceNote: "short Rs 1" });

    const body = await pendingUpload(c, d);
    // One outage throughout: the handover reset neither the outage start nor the grant.
    const payloads = body.commands.map(
      (e) => e.payload as unknown as { offlineStartedAt: number; grantId: string; kind: string },
    );
    expect(payloads.map((p) => p.kind)).toEqual([
      "shift_open",
      "ordinary_sale",
      "shift_close",
      "shift_open",
      "ordinary_sale",
      "shift_close",
    ]);
    expect(new Set(payloads.map((p) => p.offlineStartedAt)).size).toBe(1);
    expect(new Set(payloads.map((p) => p.grantId))).toEqual(new Set([c.grant.grantId]));

    const up = uploader(c, d);
    await up.sync.tick({ force: true });
    expect(statuses(up.replies.flatMap((r) => r.payload.acknowledgements))).toEqual(Array(6).fill("committed"));
    expect(await onHand(c.batches.main)).toBe(17);
    expect(readJournalSyncView(d.local.db, c.identity.enrollmentId)).toMatchObject({
      accepted: 6,
      waiting: 0,
      refused: 0,
      issue: null,
    });

    const tillShifts = await prisma.tillShift.findMany({
      where: { tenantId: c.fx.tenantId },
      orderBy: { openedAt: "asc" },
    });
    expect(tillShifts.map((s) => [s.staffUserId, s.openingCashMinor, s.closingCashCountMinor, s.expectedCashMinor])).toEqual([
      [c.cashier.userId, 5_000, cashierCount, cashierCount],
      [c.manager.userId, cashierCount, managerCount, managerCount + 100],
    ]);
    expect(tillShifts[1]!.previousClosedWorkSessionId).toBe(tillShifts[0]!.id);
    const sold = await prisma.sale.findMany({ where: { tenantId: c.fx.tenantId } });
    const by = (commandId: string) => sold.find((s) => s.offlineCommandId === commandId)!;
    expect([by(first.saleCommandId).soldBy, by(first.saleCommandId).shiftId]).toEqual([c.cashier.userId, tillShifts[0]!.id]);
    expect([by(second.saleCommandId).soldBy, by(second.saleCommandId).shiftId]).toEqual([c.manager.userId, tillShifts[1]!.id]);
  });
});
