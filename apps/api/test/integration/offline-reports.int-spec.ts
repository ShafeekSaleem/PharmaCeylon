import { randomUUID } from "node:crypto";
import { OfflineActivityReportService } from "../../src/reports/offline-activity-report.service";
import { SalesReportScopeService } from "../../src/reports/sales-report-scope.service";
import { StockDiscrepancyReportService } from "../../src/reports/stock-discrepancy-report.service";
import { ManagementApprovalsService } from "../../src/security/management-approvals.service";
import { StockCasesService } from "../../src/stock-cases/stock-cases.service";
import { createTenant } from "./fixtures";
import { access, audit, counter, offlineJournal, prisma, sales, saleAck, stock, sync, type Counter } from "./offline-counter.kit";

/**
 * W10 #72: the offline activity and stock discrepancy reports read what a real offline sync
 * stores — the counter's signed journal receipts, the sales replayed from them, and the stock
 * case a short sale opens — scoped to the tenant and branch.
 */
const scope = new SalesReportScopeService(prisma as never);
const activity = new OfflineActivityReportService(prisma as never, scope);
const discrepancies = new StockDiscrepancyReportService(prisma as never, scope);
const cases = new StockCasesService(prisma as never, audit, access, new ManagementApprovalsService(access, audit), stock);

let c: Counter;
let caseId: string;
let shortSaleId: string;
let offlineSessionId: string;

beforeAll(async () => {
  c = await counter({ partition: 10, other: 20 });
  // 7 sold online after the snapshot leaves 3 on the shelf the counter thinks holds 10.
  await sales.checkout(c.fx.tenantId, c.fx.mainBranchId, c.owner.userId, [],
    { items: [{ productId: c.fx.productId, batchId: c.batches.partition, qty: 7, unitPrice: "15.50" }] } as never, undefined);

  // Offline: open the shift, sell 5 from the short batch, then 2 from the other.
  const j = offlineJournal(c);
  const cashierIn = j.signIn(c.cashier.userId, randomUUID());
  const open = j.open(cashierIn, 0);
  offlineSessionId = open.payload.offlineSessionId;
  const response = await sync(c, {
    staffSignIns: [cashierIn],
    commands: [open, j.sale(cashierIn, [[c.batches.partition, 5]]), j.sale(cashierIn, [[c.batches.other, 2]])],
  });
  const ack = saleAck(response.payload.acknowledgements[1]!);
  caseId = ack.reconciliationCaseId!;
  shortSaleId = ack.saleId;
  expect(caseId).toBeTruthy();
  await cases.prepare(c.manager, c.fx.mainBranchId, caseId, { kind: "count_and_correct", note: "Count the shelf" });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("offline activity report", () => {
  it("rebuilds the outage from the synced journal: its sales, shift, seller and sync", async () => {
    const report = await activity.report(c.fx.tenantId, c.fx.mainBranchId, 30);
    expect(report.outages).toHaveLength(1);
    const [outage] = report.outages;
    expect(outage).toMatchObject({
      offlineSessionId,
      terminalId: c.identity.terminalId,
      entries: 3,
      sales: 2,
      salesNotHonoured: 0,
      shiftsOpened: 1,
      stockPendingSales: 1,
      awaitingReview: 0,
      status: "synced",
      staff: [{ id: c.cashier.userId, name: expect.any(String) }],
    });
    expect(outage!.salesTotalMinor).toBeGreaterThan(0);
    expect(outage!.timeToSyncMs).not.toBeNull();
    expect(outage!.counterLabel).toBe("Front");
    expect(report.kpis).toMatchObject({ outages: 1, countersAffected: 1, sales: 2, stockPendingSales: 1 });
  });

  it("shows nothing for another branch or another tenant", async () => {
    expect((await activity.report(c.fx.tenantId, c.fx.otherBranchId, 30)).outages).toHaveLength(0);
    const other = await createTenant(prisma, "offline-reports-other");
    expect((await activity.report(other.tenantId, null, 30)).outages).toHaveLength(0);
  });

  // Review rows and receipts are retained by trigger, so these run last and leave theirs behind.
  it("never loads a receipt whose signed start is before the window", async () => {
    const template = await prisma.terminalCommandReceipt.findFirstOrThrow({
      where: { tenantId: c.fx.tenantId, terminalId: c.identity.terminalId, offlineSequence: { not: null } },
    });
    const command = template.command as { payload: Record<string, unknown> };
    await prisma.terminalCommandReceipt.create({
      data: {
        tenantId: template.tenantId,
        branchId: template.branchId,
        terminalId: template.terminalId,
        enrollmentId: template.enrollmentId,
        keyId: template.keyId,
        commandId: randomUUID(),
        operation: template.operation,
        requestDigest: "0".repeat(64),
        offlineSequence: 900_000n,
        actorUserId: template.actorUserId,
        command: { ...command, payload: { ...command.payload, offlineSessionId: randomUUID(), offlineStartedAt: Date.now() - 400 * 86_400_000 } } as never,
        result: template.result as never,
      },
    });
    const report = await activity.report(c.fx.tenantId, c.fx.mainBranchId, 30);
    expect(report.outages.map((o) => o.offlineSessionId)).toEqual([offlineSessionId]);
  });

  it("counts held and unreadable review rows on their outage, and ones that name no outage apart", async () => {
    const heldSession = randomUUID();
    const startedAt = Date.now() - 3_600_000;
    let seq = 1000;
    const review = (outcome: string, payload: Record<string, unknown>) => ({
      tenantId: c.fx.tenantId,
      branchId: c.fx.mainBranchId,
      terminalId: c.identity.terminalId,
      enrollmentId: c.identity.enrollmentId,
      keyId: c.identity.keyId,
      recordKind: "command",
      recordId: randomUUID(),
      sequence: BigInt(++seq),
      recordHash: randomUUID().replace(/-/g, "").padEnd(64, "0"),
      outcome,
      errorCode: "TEST",
      envelope: { payload } as never,
      receivedByUserId: c.owner.userId,
    });
    await prisma.offlineJournalReview.createMany({
      data: [
        review("held", {
          commandId: randomUUID(), kind: "ordinary_sale", offlineSessionId: heldSession, offlineStartedAt: startedAt,
          occurredAt: startedAt + 60_000, staffSignInId: randomUUID(), totalMinor: 5_000,
        }),
        review("rejected", { offlineSessionId: heldSession, offlineStartedAt: startedAt }),
        review("rejected", { kind: "ordinary_sale" }),
      ],
    });
    const report = await activity.report(c.fx.tenantId, c.fx.mainBranchId, 30);
    expect(report.outages).toHaveLength(2);
    expect(report.outages.find((o) => o.offlineSessionId === heldSession)).toMatchObject({
      entries: 2, sales: 0, awaitingReview: 1, rejected: 1, unreadable: 1, timeToSyncMs: null, status: "needs_review",
    });
    // The synced outage is unchanged, and the entry naming no outage is still counted.
    expect(report.outages.find((o) => o.offlineSessionId === offlineSessionId)).toMatchObject({ entries: 3, status: "synced" });
    expect(report.kpis).toMatchObject({ outages: 2, entriesAwaitingReview: 2, unreadableEntries: 2, salesUnaccounted: 0 });
  });
});

describe("stock discrepancy cases report", () => {
  it("lists the open case with what was short, the batch it blocks and the prepared resolution", async () => {
    const report = await discrepancies.report(c.fx.tenantId, c.fx.mainBranchId, 30);
    expect(report.cases).toHaveLength(1);
    const [row] = report.cases;
    expect(row).toMatchObject({
      caseId,
      status: "open",
      counterLabel: "Front",
      unitsSold: 5,
      unitsShort: 2,
      reasons: ["shortfall"],
      // Managers may approve their own by default, so it is ready at the counter at once.
      resolution: { kind: "count_and_correct", status: "approved", requestedBy: { id: c.manager.userId } },
    });
    expect(row!.sale.id).toBe(shortSaleId);
    expect(row!.sale.seller?.id).toBe(c.cashier.userId);
    expect(row!.blockedBatches).toBeGreaterThan(0);
    expect(row!.lines[0]).toMatchObject({ batchId: c.batches.partition, soldQuantity: 5, availableQuantityAtSync: 3, shortfallQuantity: 2 });
    expect(report.kpis).toMatchObject({ openNow: 1, openedInRange: 1, unitsShortOpen: 2, awaitingApproval: 0, readyAtCounter: 1 });
  });

  it("spans the tenant for an owner and shows nothing at the other branch", async () => {
    expect((await discrepancies.report(c.fx.tenantId, null, 30)).cases.map((r) => r.caseId)).toEqual([caseId]);
    expect((await discrepancies.report(c.fx.tenantId, c.fx.otherBranchId, 30)).cases).toHaveLength(0);
  });
});
