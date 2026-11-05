import { ForbiddenException } from "@nestjs/common";
import type { AccessService, ActorAccess } from "../security/access.service";
import { ApproverCoSignService } from "./approver-cosign.service";
import type { PharmacistApprovalService } from "./pharmacist-approval.service";

const access = (keys: string[], canSelfApprove = false) =>
  ({ userId: "u", permissions: new Set(keys), roleKeys: [], canSelfApprove, has: (k: string) => keys.includes(k) }) as ActorAccess;

describe("ApproverCoSignService (P2b #103)", () => {
  let resolveApprovalAuthority: jest.Mock;
  let verifyApproverPin: jest.Mock;
  let service: ApproverCoSignService;
  const prisma = { marker: "prisma" };
  const tx = { marker: "tx" };

  beforeEach(() => {
    resolveApprovalAuthority = jest.fn();
    verifyApproverPin = jest.fn().mockResolvedValue({ approverUserId: "mgr", approverName: "Nimal" });
    service = new ApproverCoSignService(
      prisma as never,
      { resolveApprovalAuthority } as unknown as AccessService,
      { verifyApproverPin } as unknown as PharmacistApprovalService,
    );
  });

  it("checks the PIN against the permission the purpose takes", async () => {
    const coSign = { approverUserId: "mgr", pin: "1234" };
    await service.verify({ tenantId: "t", branchId: "b", sessionUserId: "cashier", coSign, purpose: "discount" });
    expect(verifyApproverPin).toHaveBeenLastCalledWith("t", "b", "mgr", "1234", "cashier", "sales.discount_override");
    await service.verify({ tenantId: "t", branchId: "b", sessionUserId: "cashier", coSign, purpose: "refund" });
    expect(verifyApproverPin).toHaveBeenLastCalledWith("t", "b", "mgr", "1234", "cashier", "returns.approve");
  });

  it("tags a refused PIN with the co-sign it was for, keeping the code and message", async () => {
    verifyApproverPin.mockRejectedValueOnce(
      new ForbiddenException({ code: "APPROVER_PIN_INCORRECT", message: "Incorrect till PIN" }),
    );
    await expect(
      service.verify({ tenantId: "t", branchId: "b", sessionUserId: "c", coSign: { approverUserId: "mgr", pin: "0000" }, purpose: "discount" }),
    ).rejects.toMatchObject({
      status: 403,
      response: { code: "APPROVER_PIN_INCORRECT", message: "Incorrect till PIN", coSign: "discount" },
    });
    verifyApproverPin.mockRejectedValueOnce(new ForbiddenException("Selected user can't approve this at this branch"));
    await expect(
      service.verify({ tenantId: "t", branchId: "b", sessionUserId: "c", coSign: { approverUserId: "x", pin: "1234" }, purpose: "refund" }),
    ).rejects.toMatchObject({ response: { message: "Selected user can't approve this at this branch", coSign: "refund" } });
  });

  it("refuses a co-sign by the person whose session it is, without checking the PIN", async () => {
    await expect(
      service.verify({
        tenantId: "t",
        branchId: "b",
        sessionUserId: "mgr",
        coSign: { approverUserId: "mgr", pin: "1234" },
        purpose: "discount",
      }),
    ).rejects.toMatchObject({ response: { code: "APPROVER_IS_SELF", coSign: "discount" } });
    expect(verifyApproverPin).not.toHaveBeenCalled();
  });

  it("reads the approver's authority live on the caller's transaction", async () => {
    resolveApprovalAuthority.mockResolvedValue(access(["sales.discount_override"]));
    await service.assertAuthority(tx as never, "t", "b", "mgr", "discount");
    expect(resolveApprovalAuthority).toHaveBeenCalledWith({ tenantId: "t", userId: "mgr" }, "b", tx);
  });

  it("refuses an approver without the permission, or no longer at the branch", async () => {
    resolveApprovalAuthority.mockResolvedValueOnce(access(["sales.pos_use"]));
    await expect(service.assertAuthority(tx as never, "t", "b", "mgr", "discount")).rejects.toMatchObject({
      response: { code: "APPROVER_NOT_AUTHORISED" },
    });
    resolveApprovalAuthority.mockRejectedValueOnce(new ForbiddenException("No current branch assignment"));
    await expect(service.assertAuthority(tx as never, "t", "b", "mgr", "refund")).rejects.toMatchObject({
      response: { code: "APPROVER_NOT_AUTHORISED" },
    });
  });

  it("lets a seller approve their own only with the permission and a self-approving role", async () => {
    resolveApprovalAuthority.mockResolvedValueOnce(access(["sales.discount_override"], true));
    await expect(service.sellerMayApprove("t", "b", "mgr", "discount")).resolves.toBe(true);
    resolveApprovalAuthority.mockResolvedValueOnce(access(["sales.discount_override"], false));
    await expect(service.sellerMayApprove("t", "b", "mgr", "discount")).resolves.toBe(false);
    resolveApprovalAuthority.mockResolvedValueOnce(access([], true));
    await expect(service.sellerMayApprove("t", "b", "cashier", "discount")).resolves.toBe(false);
    resolveApprovalAuthority.mockRejectedValueOnce(new ForbiddenException("Live branch authentication required"));
    await expect(service.sellerMayApprove("t", "b", "gone", "discount")).resolves.toBe(false);
    expect(resolveApprovalAuthority).toHaveBeenLastCalledWith({ tenantId: "t", userId: "gone" }, "b", prisma);
  });
});
