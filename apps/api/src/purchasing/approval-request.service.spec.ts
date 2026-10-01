import { NotFoundException } from "@nestjs/common";
import { PurchaseApprovalRequestService } from "./approval-request.service";

describe("PurchaseApprovalRequestService", () => {
  const po = { id: "po-1", poNumber: "PO-00042", supplier: { name: "Lanka Pharma" } };

  function setup(opts: { po?: typeof po | null; recentKind?: string | null; notified?: number } = {}) {
    const prisma = {
      purchaseOrder: { findFirst: jest.fn().mockResolvedValue(opts.po === undefined ? po : opts.po) },
      auditEvent: {
        findFirst: jest
          .fn()
          .mockResolvedValue(opts.recentKind ? { payload: { kind: opts.recentKind } } : null),
      },
      appUser: { findFirst: jest.fn().mockResolvedValue({ fullName: "Priya", email: "p@x" }) },
    };
    const notifications = { notifyByPermission: jest.fn().mockResolvedValue(opts.notified ?? 2) };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const service = new PurchaseApprovalRequestService(
      prisma as never,
      notifications as never,
      audit as never,
    );
    return { service, prisma, notifications, audit };
  }

  const ask = (service: PurchaseApprovalRequestService, kind: "over_delivery" | "price_variance" = "over_delivery") =>
    service.request("t-1", "b-main", "u-clerk", "po-1", { kind, detail: "12 arrived, 10 outstanding." });

  it("sends it to the approvers at this branch, not the asker, and opens the order", async () => {
    const { service, notifications, audit } = setup();
    await expect(ask(service)).resolves.toEqual({ notified: 2, alreadyAsked: false });

    const [, permission, , input, exclude, scope] = notifications.notifyByPermission.mock.calls[0];
    expect(permission).toBe("purchasing.approve");
    expect(exclude).toBe("u-clerk");
    expect(scope).toEqual({ branchId: "b-main" });
    expect(input.title).toBe("PO-00042 is waiting for your approval");
    expect(input.message).toContain("Priya");
    expect(input.message).toContain("more arrived than was ordered");
    expect(input.actionHref).toBe("/purchasing?po=po-1");
    expect(input.requiresAction).toBe(true);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: "purchase_order.approval_requested", entityId: "po-1" }),
    );
  });

  it("does not ping everyone again for the same question within minutes", async () => {
    const { service, notifications, audit } = setup({ recentKind: "over_delivery" });
    await expect(ask(service)).resolves.toEqual({ notified: 0, alreadyAsked: true });
    expect(notifications.notifyByPermission).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("still sends a different question about the same order", async () => {
    const { service, notifications } = setup({ recentKind: "over_delivery" });
    await ask(service, "price_variance");
    expect(notifications.notifyByPermission).toHaveBeenCalledTimes(1);
    expect(notifications.notifyByPermission.mock.calls[0][3].message).toContain(
      "billed above the price the order agreed",
    );
  });

  it("refuses an order that isn't at this branch", async () => {
    const { service } = setup({ po: null });
    await expect(ask(service)).rejects.toBeInstanceOf(NotFoundException);
  });
});
