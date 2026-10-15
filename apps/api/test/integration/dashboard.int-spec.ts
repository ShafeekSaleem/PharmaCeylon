import { DailyWorkService } from "../../src/dashboard/daily-work.service";
import { DashboardMetricsService } from "../../src/dashboard/dashboard-metrics.service";
import { StockReadService } from "../../src/inventory/stock/stock-read.service";
import {
  businessToday,
  startOfBusinessDay,
  addDays,
} from "../../src/common/business-date.util";
import type { RequestUser } from "../../src/security/interfaces/authenticated-request.interface";
import { PERMISSION_KEYS } from "../../src/security/permission-catalog";
import { createPrisma, createTenant, type TenantFixture } from "./fixtures";

describe("Daily dashboard read models against PostgreSQL", () => {
  const prisma = createPrisma();
  let fx: TenantFixture;
  let user: RequestUser;
  const grants = new Set(PERMISSION_KEYS);
  const access = {
    resolve: async () => ({
      canSelfApprove: false,
      has: (key: string) => grants.has(key),
    }),
  };
  const queue = () => new DailyWorkService(prisma as never, access as never);

  beforeAll(async () => {
    fx = await createTenant(prisma, "daily-dashboard");
    user = {
      userId: fx.clerkId,
      tenantId: fx.tenantId,
      email: "daily@example.test",
      fullName: "Daily operator",
      authMethod: "cookie",
      branchRoles: [{ branchId: fx.mainBranchId, role: "cashier" }],
    };
  });
  afterAll(async () => prisma.$disconnect());

  it("counts every sale beyond the recent-list cap, in the branch business day and operator scope", async () => {
    const today = businessToday("Asia/Colombo").toISOString().slice(0, 10);
    const soldAt = new Date(
      startOfBusinessDay("Asia/Colombo", today).getTime() + 5 * 60_000,
    );
    await prisma.sale.createMany({
      data: Array.from({ length: 65 }, (_, n) => ({
        tenantId: fx.tenantId,
        branchId: fx.mainBranchId,
        invoiceNo: `DASH-${n}`,
        subtotal: 10,
        grandTotal: 10,
        soldBy: fx.clerkId,
        soldAt,
      })),
    });
    await prisma.sale.create({
      data: {
        tenantId: fx.tenantId,
        branchId: fx.mainBranchId,
        invoiceNo: "OTHER-SELLER",
        subtotal: 100,
        grandTotal: 100,
        soldBy: fx.managerId,
        soldAt,
      },
    });
    await prisma.sale.create({
      data: {
        tenantId: fx.tenantId,
        branchId: fx.otherBranchId,
        invoiceNo: "OTHER-BRANCH",
        subtotal: 1000,
        grandTotal: 1000,
        soldBy: fx.clerkId,
        soldAt,
      },
    });
    const service = new DashboardMetricsService(
      prisma as never,
      new StockReadService(prisma as never),
    );
    const result = await service.sales(user, fx.mainBranchId);
    expect(result.scope).toBe("personal");
    expect(result.today).toMatchObject({ count: 65, total: 650 });
    expect(result.hourly[0]).toMatchObject({ count: 65, total: 650 });
    expect(result.hourly).toHaveLength(24);
    const branch = await service.sales(
      {
        ...user,
        branchRoles: [{ branchId: fx.mainBranchId, role: "manager" }],
      },
      fx.mainBranchId,
    );
    expect(branch.today.count).toBe(66);
    expect(branch.today.total).toBe(750);
  });

  it("paginates complete counts, excludes other branches, and does not mark today's date overdue", async () => {
    await prisma.purchaseOrder.createMany({
      data: Array.from({ length: 14 }, (_, n) => ({
        tenantId: fx.tenantId,
        branchId: fx.mainBranchId,
        supplierId: fx.supplierId,
        poNumber: `WORK-${n}`,
        status: "pending_approval" as const,
        createdBy: fx.managerId,
        expectedOn: businessToday("Asia/Colombo"),
      })),
    });
    await prisma.purchaseOrder.create({
      data: {
        tenantId: fx.tenantId,
        branchId: fx.otherBranchId,
        supplierId: fx.supplierId,
        poNumber: "HIDDEN-BRANCH",
        status: "pending_approval",
        createdBy: fx.managerId,
      },
    });
    const page1 = await queue().get(user, fx.mainBranchId, {
      filter: "approvals",
      category: "purchasing",
      page: 1,
    });
    const page2 = await queue().get(user, fx.mainBranchId, {
      filter: "approvals",
      category: "purchasing",
      page: 2,
    });
    expect(page1.total).toBe(14);
    expect(page1.counts.overdue).toBe(0);
    expect(page1.items).toHaveLength(page1.pageSize);
    expect(
      new Set([...page1.items, ...page2.items].map((i) => i.id)).size,
    ).toBe(page1.items.length + page2.items.length);
  });

  it("explains self-approval blocks and removes completed workflows without a separate task update", async () => {
    const own = await prisma.purchaseOrder.create({
      data: {
        tenantId: fx.tenantId,
        branchId: fx.mainBranchId,
        supplierId: fx.supplierId,
        poNumber: "SELF-BLOCKED",
        status: "pending_approval",
        createdBy: fx.clerkId,
        expectedOn: addDays(businessToday("Asia/Colombo"), -1),
      },
    });
    const before = await queue().get(user, fx.mainBranchId, {
      filter: "overdue",
      category: "purchasing",
      page: 1,
    });
    expect(before.items.find((i) => i.id === `po:${own.id}`)).toMatchObject({
      blocked: true,
      action: "View request",
      overdue: true,
    });
    const decisions = await queue().get(user, fx.mainBranchId, {
      filter: "approvals",
      category: "purchasing",
      page: 1,
    });
    expect(decisions.total).toBe(14);
    await prisma.purchaseOrder.update({
      where: { id: own.id },
      data: { status: "received" },
    });
    const after = await queue().get(user, fx.mainBranchId, {
      filter: "overdue",
      category: "purchasing",
      page: 1,
    });
    expect(after.total).toBe(0);
  });

  it("gates sources by effective permissions, including custom roles", async () => {
    const restricted = new DailyWorkService(
      prisma as never,
      {
        resolve: async () => ({ canSelfApprove: false, has: () => false }),
      } as never,
    );
    expect(
      (await restricted.get(user, fx.mainBranchId, { filter: "all", page: 1 }))
        .total,
    ).toBe(0);
    const custom = {
      ...user,
      branchRoles: [{ branchId: fx.mainBranchId, role: "custom" as const }],
    };
    expect(
      (
        await queue().get(custom, fx.mainBranchId, {
          filter: "approvals",
          category: "purchasing",
          page: 1,
        })
      ).total,
    ).toBe(14);
  });

  it("supports a cashier-only source without relying on another workflow's SQL aliases", async () => {
    const held = await prisma.heldSale.create({
      data: {
        tenantId: fx.tenantId,
        branchId: fx.mainBranchId,
        holdRef: "DAILY-HOLD",
        heldBy: fx.clerkId,
        payload: { meta: { needsPharmacist: true } },
        itemCount: 1,
        total: 10,
      },
    });
    const cashier = new DailyWorkService(
      prisma as never,
      {
        resolve: async () => ({
          canSelfApprove: false,
          has: (key: string) => key === "sales.pos_use",
        }),
      } as never,
    );
    const work = await cashier.get(user, fx.mainBranchId, {
      filter: "all",
      page: 1,
    });
    expect(work.items).toEqual([
      expect.objectContaining({
        id: `hold:${held.id}`,
        status: "needs_review",
        mine: true,
      }),
    ]);
    await prisma.heldSale.delete({ where: { id: held.id } });
    expect(
      (await cashier.get(user, fx.mainBranchId, { filter: "all", page: 1 }))
        .total,
    ).toBe(0);
  });
});
