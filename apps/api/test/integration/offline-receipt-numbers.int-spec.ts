import { randomUUID } from "node:crypto";
import { acceptedJournalState, issueOfflineAuthority } from "../../src/terminals/offline-authority-issuance";
import { offlineReceiptNumbering } from "../../src/terminals/offline-receipt-numbering";
import { access, counter, offlineJournal, prisma, saleAck, signer, sync } from "./offline-counter.kit";

/**
 * P4 #50, receipt numbering option A: the number on an offline receipt is final. Each till numbers
 * under its own prefix, the grant says where to start, and the sale keeps the number as its invoice.
 */

afterAll(async () => {
  await prisma.$disconnect();
});

const renew = (c: Awaited<ReturnType<typeof counter>>) =>
  issueOfflineAuthority(prisma as never, access, {
    signer,
    defaultVatRatePercent: 18,
    authenticate: async () => ({ identity: c.identity, commandId: randomUUID() }),
    readState: acceptedJournalState,
  });

describe("offline receipt numbers (P4 #50, option A)", () => {
  it("gives the till a prefix once, and its sales keep their receipt numbers as invoice numbers", async () => {
    const c = await counter({ main: 20 });
    expect(c.grant.receiptNumbering).toEqual({ prefix: "C1R", nextNumber: 1 });
    const till = await prisma.terminalCounter.findFirstOrThrow({ where: { tenantId: c.fx.tenantId, tillId: c.grant.tillId } });
    expect(till.offlineReceiptPrefix).toBe("C1R");

    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    const open = j.open(cashierIn, 0);
    const sales = [j.sale(cashierIn, [[c.batches.main, 1]]), j.sale(cashierIn, [[c.batches.main, 2]])];
    const response = await sync(c, { staffSignIns: [cashierIn], commands: [open, ...sales] });
    const saleIds = response.payload.acknowledgements.slice(1).map((a) => saleAck(a).saleId);
    const stored = await prisma.sale.findMany({ where: { id: { in: saleIds } }, orderBy: { invoiceNo: "asc" } });
    expect(stored.map((s) => s.invoiceNo)).toEqual(["C1R-000001", "C1R-000002"]);

    // The next grant starts after what the server has seen; the prefix doesn't move.
    const renewed = await renew(c);
    expect(renewed.grant.payload.receiptNumbering).toEqual({ prefix: "C1R", nextNumber: 3 });
    await expect(
      prisma.terminalCounter.update({ where: { id: till.id }, data: { offlineReceiptPrefix: "C9R" } }),
    ).rejects.toThrow(/never changes/);
  });

  it("gives a second till at the branch the next free prefix", async () => {
    const c = await counter({ main: 5 });
    const other = await prisma.terminalCounter.create({
      data: { tenantId: c.fx.tenantId, branchId: c.fx.mainBranchId, label: "Back" },
    });
    const numbering = await prisma.$transaction((tx) =>
      offlineReceiptNumbering(tx, { tenantId: c.fx.tenantId, branchId: c.fx.mainBranchId, tillId: other.tillId }),
    );
    expect(numbering).toEqual({ prefix: "C2R", nextNumber: 1 });
    // Asked again, the same till keeps its prefix.
    const again = await prisma.$transaction((tx) =>
      offlineReceiptNumbering(tx, { tenantId: c.fx.tenantId, branchId: c.fx.mainBranchId, tillId: other.tillId }),
    );
    expect(again.prefix).toBe("C2R");
  });

  it("refuses a sale whose receipt number another sale already holds", async () => {
    const c = await counter({ main: 20 });
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    const open = j.open(cashierIn, 0);
    const first = j.sale(cashierIn, [[c.batches.main, 1]]);
    // A counter that reused a number: same receipt, a new journal entry.
    const reused = j.sale(cashierIn, [[c.batches.main, 1]], { receiptNumber: first.payload.receiptNumber });
    const response = await sync(c, { staffSignIns: [cashierIn], commands: [open, first, reused] });
    const [, accepted, refused] = response.payload.acknowledgements;
    expect(accepted).toMatchObject({ status: "committed" });
    expect(refused).toMatchObject({ status: "rejected", error: { code: "REPLAY_CONFLICT" } });
    expect(await prisma.sale.count({ where: { tenantId: c.fx.tenantId, invoiceNo: first.payload.receiptNumber } })).toBe(1);
  });
});
