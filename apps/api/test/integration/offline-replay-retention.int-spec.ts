import { randomUUID } from "node:crypto";
import { REPLAY_RETAINED_TABLES, REPLAY_RETENTION_EXEMPT } from "../../src/terminals/journal/replay-retention";
import { prisma, counter, offlineJournal, sync, saleAck, onHand } from "./offline-counter.kit";

/**
 * P5 #51 item 11: nothing that answers a journal replay is ever purged, so expiry or a cleanup job
 * can't turn a known command into a new business effect. See replay-retention.ts.
 */

afterAll(async () => {
  await prisma.$disconnect();
});

describe("offline journal replay retention (P5 #51)", () => {
  it("every replay table refuses DELETE, and every offline_* table is classified", async () => {
    const guarded = await prisma.$queryRaw<{ table: string }[]>`
      SELECT DISTINCT c.relname AS table FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND (t.tgtype & 2) <> 0 AND (t.tgtype & 8) <> 0 AND (t.tgtype & 1) <> 0`;
    const withDeleteGuard = new Set(guarded.map((r) => r.table));
    for (const table of Object.keys(REPLAY_RETAINED_TABLES))
      expect({ table, refusesDelete: withDeleteGuard.has(table) }).toEqual({ table, refusesDelete: true });

    const offline = await prisma.$queryRaw<{ table: string }[]>`
      SELECT tablename AS table FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE 'offline\\_%'`;
    const classified = new Set([...Object.keys(REPLAY_RETAINED_TABLES), ...Object.keys(REPLAY_RETENTION_EXEMPT)]);
    expect(offline.map((r) => r.table).filter((t) => !classified.has(t))).toEqual([]);
  });

  it("an identical replay after grant expiry and an attempted purge returns the original receipts, with no new effect", async () => {
    const c = await counter({ main: 20 });
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    const open = j.open(cashierIn, 0);
    const sale = j.sale(cashierIn, [[c.batches.main, 2]]);
    const commands = [open, sale];
    const first = await sync(c, { staffSignIns: [cashierIn], commands });
    expect(first.payload.acknowledgements.map((a) => a.status)).toEqual(["committed", "committed"]);
    const original = saleAck(first.payload.acknowledgements[1]!);
    const committedAt = (first.payload.acknowledgements[1] as { committedAt: number }).committedAt;
    const where = { tenantId: c.fx.tenantId, enrollmentId: c.identity.enrollmentId };
    const receiptsBefore = await prisma.terminalCommandReceipt.findMany({ where, orderBy: { offlineSequence: "asc" } });

    // A retention job — TTL on expired rows, `auditLogRetentionDays`, anything — finds the grant,
    // its snapshot, the receipts and sign-ins long past their dates and tries to purge them.
    const purges: Array<[string, () => Promise<unknown>]> = [
      ["terminal_command_receipt", () => prisma.terminalCommandReceipt.deleteMany({ where })],
      ["offline_staff_sign_in", () => prisma.offlineStaffSignIn.deleteMany({ where })],
      ["offline_authority_issuance", () => prisma.offlineAuthorityIssuance.deleteMany({ where: { tenantId: c.fx.tenantId } })],
      ["offline_stock_snapshot", () => prisma.offlineStockSnapshot.deleteMany({ where: { tenantId: c.fx.tenantId } })],
      [
        "terminal_command_receipt (raw, by age)",
        () => prisma.$executeRaw`DELETE FROM terminal_command_receipt WHERE tenant_id = ${c.fx.tenantId}::uuid AND recorded_at < now() + interval '1 day'`,
      ],
    ];
    for (const [label, purge] of purges)
      await expect(purge().then(() => `${label} purged`)).rejects.toThrow(/retained|append-only|immutable|preserved|must|cannot|not/i);

    // Long after the grant expired, the counter sends the same bytes again.
    const afterExpiry = c.grant.expiresAt + 30 * 24 * 60 * 60 * 1000;
    const replay = await sync(c, { staffSignIns: [cashierIn], commands }, afterExpiry);
    expect(replay.payload.acknowledgements.map((a) => a.status)).toEqual(["duplicate", "duplicate"]);
    expect(saleAck(replay.payload.acknowledgements[1]!).saleId).toBe(original.saleId);
    expect(replay.payload.acknowledgements[1]).toMatchObject({ committedAt });
    expect(replay.payload.committedThroughSequence).toBe(first.payload.committedThroughSequence);
    expect(replay.payload.committedThroughHash).toBe(first.payload.committedThroughHash);

    // No new effect: one sale, the stock moved once, the receipts are the originals.
    expect(await prisma.sale.count({ where: { tenantId: c.fx.tenantId } })).toBe(1);
    expect(await onHand(c.batches.main)).toBe(18);
    expect(await prisma.terminalCommandReceipt.findMany({ where, orderBy: { offlineSequence: "asc" } })).toEqual(receiptsBefore);

    // A changed copy of an accepted entry is a conflict, never a second sale.
    const altered = j.tamper(sale, { lines: [{ ...sale.payload.lines[0]!, quantity: 1 }] });
    const changed = await sync(c, { commands: [altered] }, afterExpiry);
    expect(changed.payload.acknowledgements[0]).toMatchObject({ status: "rejected", error: { code: "REPLAY_CONFLICT" } });
    expect(await prisma.sale.count({ where: { tenantId: c.fx.tenantId } })).toBe(1);
  });
});
