import { randomUUID } from "node:crypto";
import * as bcrypt from "bcrypt";
import { PaymentMethod, Prisma, StockMovementType } from "@prisma/client";
import { AuditService } from "../../src/audit/audit.service";
import { StockService } from "../../src/inventory/stock/stock.service";
import { TaxService } from "../../src/pricing/tax.service";
import { createTenantAwarePrismaProxy } from "../../src/prisma/tenant-aware-prisma.proxy";
import { ApproverCoSignService } from "../../src/sales/approver-cosign.service";
import { PharmacistApprovalService } from "../../src/sales/pharmacist-approval.service";
import { RefundRequestsService } from "../../src/sales/refund-requests.service";
import { SalesService } from "../../src/sales/sales.service";
import { AccessService } from "../../src/security/access.service";
import type { RequestUser } from "../../src/security/interfaces/authenticated-request.interface";
import { ManagementApprovalsService } from "../../src/security/management-approvals.service";
import { PermissionsService } from "../../src/security/permissions.service";
import type { PinAlerts } from "../../src/terminals/pin-alerts.service";
import { createPrisma, createStockedBatch, createTenant, type TenantFixture } from "./fixtures";

/**
 * P2b #103: the approver co-sign, shared by discounts over `posMaxDiscountPercent` and refunds
 * over the approval threshold. A manager approves on someone else's session with their own PIN;
 * their authority and the limit are read live; seller and approver are recorded separately.
 */
const prisma = createPrisma();
const proxy = createTenantAwarePrismaProxy(prisma);
const audit = new AuditService(proxy as never);
const access = new AccessService(proxy as never, {} as never);
// A real, caching permissions resolver: the co-sign's PIN step reads through it, so a grant
// removed behind its back shows that the authority check after it reads the database instead.
const permissions = new PermissionsService(proxy as never, { get: () => 300 } as never);
const pins = new PharmacistApprovalService(proxy as never, audit, permissions, {} as never, {
  switchedOff: async () => undefined,
} as unknown as PinAlerts);
const coSign = new ApproverCoSignService(proxy as never, access, pins);
const stock = new StockService();
const sales = new SalesService(
  proxy as never,
  audit,
  new TaxService({ get: () => "0" } as never),
  pins,
  { assertCanSell: async () => undefined } as never,
  stock,
  undefined,
  undefined,
  undefined,
  coSign,
);
const approvals = new ManagementApprovalsService(access, audit);
const refunds = new RefundRequestsService(proxy as never, audit, access, approvals, sales, stock, coSign);

const PIN = "2468";
let fx: TenantFixture;
let pharmacistId: string;
let supervisorId: string;
let supervisorRoleId: string;
let batchId: string;

const user = (userId: string): RequestUser => ({
  userId, tenantId: fx.tenantId, tokenVersion: 0, branchRoles: [], email: "cosign@it.test",
  fullName: "Co-sign actor", authMethod: "bearer",
});
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (e: { response?: { code?: string } }) => e.response?.code ?? String(e),
  );
const setLimit = (percent: string) =>
  prisma.tenantSettings.upsert({
    where: { tenantId: fx.tenantId },
    create: { tenantId: fx.tenantId, posMaxDiscountPercent: percent },
    update: { posMaxDiscountPercent: percent },
  });

async function staff(label: string) {
  const row = await prisma.appUser.create({
    data: { tenantId: fx.tenantId, email: `${label}-${randomUUID().slice(0, 8)}@it.test`, fullName: `${label} person`, passwordHash: "not-used" },
  });
  await prisma.tenantMembership.create({ data: { tenantId: fx.tenantId, userId: row.id } });
  return row.id;
}

beforeAll(async () => {
  fx = await createTenant(prisma, "approver-cosign");
  pharmacistId = await staff("pharmacist");
  supervisorId = await staff("supervisor");
  // A tenant-defined role granted the discount override, for the live-authority check. The
  // migration adds the new permission row; the database starts without the seeded catalog.
  await prisma.permission.createMany({ skipDuplicates: true, data: ["sales.pos_use", "sales.discount_override"]
    .map((key) => ({ key, module: "sales", label: key, description: key })) });
  supervisorRoleId = (await prisma.role.create({
    data: { tenantId: fx.tenantId, key: `supervisor-${randomUUID().slice(0, 6)}`, name: "Supervisor" },
  })).id;
  await prisma.rolePermission.createMany({ data: ["sales.pos_use", "sales.discount_override"].map((permissionKey) => ({
    tenantId: fx.tenantId, roleId: supervisorRoleId, permissionKey,
  })) });
  await prisma.userBranchRole.createMany({ data: [
    { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.ownerId, role: "owner" },
    { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.managerId, role: "manager" },
    { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.clerkId, role: "cashier" },
    { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: pharmacistId, role: "pharmacist" },
    { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: supervisorId, role: "custom", roleId: supervisorRoleId },
  ] });
  const posPinHash = await bcrypt.hash(PIN, 4);
  await prisma.appUser.updateMany({ where: { id: { in: [fx.managerId, pharmacistId, supervisorId, fx.clerkId] } }, data: { posPinHash } });
  batchId = await createStockedBatch(prisma, stock, fx, { qty: 500 });
});
afterEach(async () => {
  await prisma.tenantSettings.updateMany({
    where: { tenantId: fx.tenantId },
    data: { posMaxDiscountPercent: "10", approvalRequiredReturnThreshold: null, selfApprovalRoleKeys: ["owner", "manager"] },
  });
  await prisma.appUser.updateMany({ where: { tenantId: fx.tenantId }, data: { failedPosPinAttempts: 0, posPinLockedUntil: null } });
});
afterAll(() => prisma.$disconnect());

describe("line discounts at checkout", () => {
  /** Two units at 100.00 (subtotal 200.00) with `discount` off the line. */
  const sell = (sellerId: string, discount: string, discountApproval?: { approverUserId: string; pin: string }) =>
    sales.checkout(
      fx.tenantId,
      fx.mainBranchId,
      sellerId,
      [],
      { items: [{ productId: fx.productId, batchId, qty: 2, unitPrice: "100.00", discountAmount: discount }],
        ...(discountApproval ? { discountApproval } : {}) },
      randomUUID(),
    );
  const soldBy = (userId: string) => prisma.sale.count({ where: { tenantId: fx.tenantId, soldBy: userId } });
  const onHand = async () => (await prisma.batchStock.findUniqueOrThrow({ where: { batchId } })).onHandQty;

  it("under the limit, a cashier discounts alone and nobody is recorded as approving", async () => {
    await setLimit("10");
    const sale = await sell(fx.clerkId, "20.00");
    const stored = await prisma.sale.findUniqueOrThrow({ where: { id: sale!.id } });
    expect(stored).toMatchObject({ soldBy: fx.clerkId, discountApprovedBy: null });
    expect(stored.discountTotal.toFixed(2)).toBe("20.00");
    expect(stored.grandTotal.toFixed(2)).toBe("180.00");
    expect(await prisma.auditEvent.count({ where: { tenantId: fx.tenantId, eventName: "sale.discount_approved", entityId: sale!.id } })).toBe(0);
  });

  it("over the limit, refuses the cashier without a co-sign and sells nothing", async () => {
    await setLimit("10");
    const [before, stockBefore] = [await soldBy(fx.clerkId), await onHand()];
    await expect(sell(fx.clerkId, "20.02")).rejects.toMatchObject({
      status: 403,
      response: { code: "DISCOUNT_APPROVAL_REQUIRED", limitPercent: 10, maxPercent: 10.01 },
    });
    expect(await soldBy(fx.clerkId)).toBe(before);
    expect(await onHand()).toBe(stockBefore);
  });

  it("over the limit, accepts a manager's co-sign and records seller and approver separately", async () => {
    await setLimit("10");
    const sale = await sell(fx.clerkId, "50.00", { approverUserId: fx.managerId, pin: PIN });
    expect(sale).toMatchObject({ discountApprover: { id: fx.managerId }, seller: { id: fx.clerkId } });
    const stored = await prisma.sale.findUniqueOrThrow({ where: { id: sale!.id } });
    expect(stored).toMatchObject({ soldBy: fx.clerkId, discountApprovedBy: fx.managerId });
    const approved = await prisma.auditEvent.findFirstOrThrow({
      where: { tenantId: fx.tenantId, eventName: "sale.discount_approved", entityId: sale!.id },
    });
    expect(approved.actorUserId).toBe(fx.managerId);
    expect(approved.payload).toMatchObject({
      soldByUserId: fx.clerkId, approvedByUserId: fx.managerId, coSigned: true, limitPercent: 10, maxLinePercent: 25,
    });
    // The PIN goes nowhere: not into the audit trail.
    const trail = await prisma.auditEvent.findMany({ where: { tenantId: fx.tenantId } });
    expect(JSON.stringify(trail)).not.toContain(PIN);
  });

  it("a manager discounts their own sale over the limit under their own authority, recorded as theirs", async () => {
    await setLimit("10");
    const sale = await sell(fx.managerId, "60.00");
    expect(await prisma.sale.findUniqueOrThrow({ where: { id: sale!.id } }))
      .toMatchObject({ soldBy: fx.managerId, discountApprovedBy: fx.managerId });
    // The tenant's self-approval rule is kept: a manager who may not approve their own needs a co-sign.
    await prisma.tenantSettings.update({ where: { tenantId: fx.tenantId }, data: { selfApprovalRoleKeys: ["owner"] } });
    await expect(code(sell(fx.managerId, "60.00"))).resolves.toBe("DISCOUNT_APPROVAL_REQUIRED");
    await expect(code(sell(fx.managerId, "60.00", { approverUserId: fx.managerId, pin: PIN }))).resolves.toBe("APPROVER_IS_SELF");
  });

  it("refuses a co-sign from someone with no discount authority, and a wrong PIN", async () => {
    await setLimit("10");
    const before = await soldBy(fx.clerkId);
    // A pharmacist can co-sign controlled medicines, not discounts.
    await expect(sell(fx.clerkId, "50.00", { approverUserId: pharmacistId, pin: PIN })).rejects.toMatchObject({ status: 403 });
    await expect(code(sell(fx.clerkId, "50.00", { approverUserId: fx.managerId, pin: "1111" }))).resolves.toBe("APPROVER_PIN_INCORRECT");
    expect(await soldBy(fx.clerkId)).toBe(before);
    const failed = await prisma.auditEvent.findFirstOrThrow({
      where: { tenantId: fx.tenantId, eventName: "sale.pharmacist_pin_failed", entityId: fx.managerId },
      orderBy: { createdAt: "desc" },
    });
    expect(failed.payload).toMatchObject({ permission: "sales.discount_override" });
  });

  it("reads the approver's authority live: a grant removed a moment ago no longer co-signs", async () => {
    await setLimit("10");
    // Warm the permission cache with the grant, as a co-sign a minute earlier would have.
    await expect(code(sell(fx.clerkId, "50.00", { approverUserId: supervisorId, pin: PIN }))).resolves.toBe("ok");
    await prisma.rolePermission.deleteMany({ where: { roleId: supervisorRoleId, permissionKey: "sales.discount_override" } });
    const before = await soldBy(fx.clerkId);
    // The PIN step still sees the cached grant; the live check after it does not.
    await expect(code(sell(fx.clerkId, "50.00", { approverUserId: supervisorId, pin: PIN }))).resolves.toBe("APPROVER_NOT_AUTHORISED");
    expect(await soldBy(fx.clerkId)).toBe(before);
  });

  it("reads the limit live: a limit raised or lowered between two sales applies to the next", async () => {
    await setLimit("30");
    await expect(code(sell(fx.clerkId, "50.00"))).resolves.toBe("ok");
    await setLimit("5");
    await expect(code(sell(fx.clerkId, "12.00"))).resolves.toBe("DISCOUNT_APPROVAL_REQUIRED");
  });
});

describe("a prepared refund over the threshold, approved at the counter", () => {
  /** A posted cash sale of `qty` units at 100.00 each, stock issued through StockService. */
  async function cashSale(qty = 3) {
    const total = new Prisma.Decimal(100).mul(qty);
    const sale = await prisma.sale.create({ data: {
      tenantId: fx.tenantId, branchId: fx.mainBranchId, invoiceNo: `INV-${randomUUID().slice(0, 8)}`,
      subtotal: total, grandTotal: total, amountPaid: total, soldBy: fx.clerkId,
      items: { create: { tenantId: fx.tenantId, productId: fx.productId, batchId, qty, unitPrice: "100.00", lineTotal: total } },
      payments: { create: { tenantId: fx.tenantId, method: PaymentMethod.cash, amount: total } },
    } });
    await prisma.$transaction((c) => stock.issue(c, { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.clerkId,
      referenceType: "sale", referenceId: sale.id },
    [{ productId: fx.productId, batchId, qty, movementType: StockMovementType.sale_out, from: "sellable" as const }]));
    return sale.id;
  }
  async function prepared() {
    await prisma.tenantSettings.upsert({
      where: { tenantId: fx.tenantId },
      create: { tenantId: fx.tenantId, approvalRequiredReturnThreshold: "150.00" },
      update: { approvalRequiredReturnThreshold: "150.00" },
    });
    const saleId = await cashSale();
    // The cashier at the counter prepares it; their role can't approve refunds.
    const request = await refunds.prepare(user(fx.clerkId), fx.mainBranchId, saleId, {
      reasonCode: "damaged", items: [{ productId: fx.productId, batchId, qty: 2 }],
    });
    expect(request).toMatchObject({ approvalRequired: true, readyAtCounter: false, executionApprovalId: null });
    return request;
  }
  const approve = (request: Awaited<ReturnType<typeof prepared>>, as: string, cosign?: { approverUserId: string; pin: string }) =>
    refunds.approve(user(as), fx.mainBranchId, request.id, {
      approvalId: randomUUID(), ...request.approvalReview!, ...(cosign ? { coSign: cosign } : {}),
    });

  it("is refused for the cashier without the co-sign, and cannot be refunded", async () => {
    const request = await prepared();
    await expect(code(approve(request, fx.clerkId))).resolves.toBe("PERMISSION_DENIED");
    await expect(code(refunds.execute(user(fx.clerkId), fx.mainBranchId, request.id, { approvalId: null })))
      .resolves.toBe("APPROVAL_REQUIRED");
  });

  it("is approved by a manager's co-sign on the cashier's session, with requester, approver and executor kept apart", async () => {
    const request = await prepared();
    await expect(code(approve(request, fx.clerkId, { approverUserId: fx.managerId, pin: "0000" }))).resolves.toBe("APPROVER_PIN_INCORRECT");
    // A pharmacist can't approve refunds, whatever their PIN.
    await expect(approve(request, fx.clerkId, { approverUserId: pharmacistId, pin: PIN })).rejects.toMatchObject({ status: 403 });
    await expect(code(approve(request, fx.clerkId, { approverUserId: fx.clerkId, pin: PIN }))).resolves.toBe("APPROVER_IS_SELF");

    const approved = await approve(request, fx.clerkId, { approverUserId: fx.managerId, pin: PIN });
    expect(approved).toMatchObject({ status: "approved", readyAtCounter: true,
      requester: { id: fx.clerkId }, approver: { id: fx.managerId }, executor: null });
    const evidence = await prisma.managementApproval.findUniqueOrThrow({ where: { id: approved.executionApprovalId! } });
    expect(evidence).toMatchObject({ approvedByUserId: fx.managerId, requestedByUserId: fx.clerkId });
    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { tenantId: fx.tenantId, eventName: "sale.refund_approved", entityId: request.id },
    });
    expect(event.actorUserId).toBe(fx.managerId);
    expect(event.payload).toMatchObject({ coSigned: true, coSignedOnSessionOfUserId: fx.clerkId, approvedByUserId: fx.managerId });

    const executed = await refunds.execute(user(fx.clerkId), fx.mainBranchId, request.id, { approvalId: approved.executionApprovalId });
    expect(executed).toMatchObject({ status: "executed", requester: { id: fx.clerkId }, approver: { id: fx.managerId }, executor: { id: fx.clerkId } });
  });

  it("keeps the self-approval rule for the co-signer, and the approve-as-yourself path", async () => {
    await prisma.tenantSettings.upsert({ where: { tenantId: fx.tenantId }, create: { tenantId: fx.tenantId, selfApprovalRoleKeys: ["owner"] },
      update: { selfApprovalRoleKeys: ["owner"] } });
    const saleId = await cashSale();
    await prisma.tenantSettings.update({ where: { tenantId: fx.tenantId }, data: { approvalRequiredReturnThreshold: "150.00" } });
    // Prepared by the manager, whose role may no longer approve its own: their co-sign on the
    // cashier's session is still their own approval, and is refused.
    const request = await refunds.prepare(user(fx.managerId), fx.mainBranchId, saleId, {
      reasonCode: "damaged", items: [{ productId: fx.productId, batchId, qty: 2 }],
    });
    await expect(approve(request, fx.clerkId, { approverUserId: fx.managerId, pin: PIN })).rejects.toMatchObject({ status: 403 });
    // The owner approves as themselves, as before.
    await expect(approve(request, fx.ownerId)).resolves.toMatchObject({ status: "approved", approver: { id: fx.ownerId } });
  });
});
