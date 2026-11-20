import { RoleName } from "@prisma/client";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { SalesQueuesService } from "./sales-queues.service";

const user: RequestUser = {
  userId: "user-1",
  tenantId: "tenant-1",
  tokenVersion: 0,
  email: "o@t.test",
  fullName: "Owner",
  authMethod: "bearer",
  branchRoles: [{ branchId: "branch-a", role: RoleName.owner }],
};

describe("SalesQueuesService", () => {
  it("scopes incident notes to tenant and branch", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const count = jest.fn().mockResolvedValue(0);
    const prisma = {
      offlineSupportRecord: { findMany, count },
      operationalTerminal: { findMany: jest.fn().mockResolvedValue([]) },
      terminalCounter: { findMany: jest.fn().mockResolvedValue([]) },
      appUser: { findMany: jest.fn().mockResolvedValue([]) },
      sale: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new SalesQueuesService(prisma as never);
    await service.incidentNotes(user, "branch-a", {});

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: "tenant-1",
          branchId: "branch-a",
          kind: "sale_incident",
          status: "accepted",
        }),
      }),
    );
  });

  it("scopes payment recovery to manager-held card attempts", async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        attemptId: "attempt-1",
        terminalId: "term-1",
        heldReason: "card_not_used",
        amountMinor: 100n,
        providerReference: "RRN",
        approvalCode: "OK",
        cardState: "not_used",
        recordedAt: new Date("2026-10-01T00:00:00.000Z"),
        receivedAt: new Date("2026-10-01T00:01:00.000Z"),
        saleCommandId: null,
      },
    ]);
    const prisma = {
      offlineSupportRecord: { findMany },
      operationalTerminal: {
        findMany: jest.fn().mockResolvedValue([{ id: "term-1", label: "Desk", registerId: null }]),
      },
      terminalCounter: { findMany: jest.fn().mockResolvedValue([]) },
      sale: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new SalesQueuesService(prisma as never);
    const result = await service.paymentRecovery(user, "branch-a", {});
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.heldReason).toBe("card_not_used");
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: "tenant-1",
          branchId: "branch-a",
          kind: "external_card_attempt",
        }),
      }),
    );
  });

  it("marks every collected-money row unresolved", async () => {
    const settlementId = "settlement-1";
    const findMany = jest.fn().mockResolvedValue([
      {
        id: "pay-1",
        branchId: "branch-a",
        amountMinor: 2500n,
        method: "external_card",
        providerReference: "RRN",
        approvalCode: "OK",
        approvedAt: null,
        collectedAt: new Date("2026-10-01T00:00:00.000Z"),
        shiftId: null,
        staffUserId: "user-1",
        settlementId,
        commandId: "cmd-1",
        settlement: { id: settlementId, reviewId: "review-1", commandId: "cmd-1" },
        shift: null,
      },
    ]);
    const count = jest.fn().mockResolvedValue(1);
    const prisma = {
      offlineCollectedPayment: { findMany, count },
      appUser: { findMany: jest.fn().mockResolvedValue([{ id: "user-1", fullName: "Cashier" }]) },
      offlineJournalReview: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "review-1",
            envelope: { payload: { kind: "ordinary_sale", receiptNumber: "C1R-000010" } },
          },
        ]),
      },
    };
    const service = new SalesQueuesService(prisma as never);
    const result = await service.collectedMoney(user, "branch-a", {});
    expect(result.items[0]).toMatchObject({
      status: "unresolved",
      receiptNumber: "C1R-000010",
      amountMinor: 2500,
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: "tenant-1", branchId: "branch-a" },
      }),
    );
  });
});