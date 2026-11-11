import { randomUUID } from "node:crypto";
import { nextTenantDocumentNumber } from "../../src/common/document-sequence.util";
import { createPrisma, createTenant, type TenantFixture } from "./fixtures";

/**
 * A tenant-wide number (supplier payments, transfers, refund requests) is counted on one branch
 * row. Which branch must not change once a number has been issued: the fixture's two branches
 * are created together and tie on `created_at`, and the tied row Postgres returns first depends
 * on the plan, so re-choosing "the first branch" on each call restarted the count at 1 and
 * collided with the tenant's unique payment number.
 */
const prisma = createPrisma();
const next = (fx: TenantFixture) =>
  prisma.$transaction((tx) =>
    nextTenantDocumentNumber(tx, fx.tenantId, "supplier_payment", "PAY-"),
  );
const holder = async (fx: TenantFixture) =>
  (
    await prisma.documentSequence.findMany({
      where: { tenantId: fx.tenantId, docType: "tenant:supplier_payment" },
      select: { branchId: true },
    })
  ).map((row) => row.branchId);

afterAll(async () => {
  await prisma.$disconnect();
});

it("keeps counting on the branch that holds the tenant's counter, whichever branch sorts first", async () => {
  const fx = await createTenant(prisma, "doc-sequence");
  expect(await next(fx)).toBe("PAY-00001");
  const [home] = await holder(fx);
  const elsewhere =
    home === fx.mainBranchId ? fx.otherBranchId : fx.mainBranchId;

  // The other branch now sorts first by any plan: the count still continues where it was.
  await prisma.branch.update({
    where: { id: elsewhere },
    data: { createdAt: new Date("2020-01-01T00:00:00Z") },
  });
  expect(await next(fx)).toBe("PAY-00002");
  expect(await holder(fx)).toEqual([home]);
});

it("continues the higher count for a tenant whose counter already split across branches", async () => {
  const fx = await createTenant(prisma, "doc-sequence-split");
  await prisma.documentSequence.createMany({
    data: [
      { branchId: fx.mainBranchId, nextValue: 3 },
      { branchId: fx.otherBranchId, nextValue: 6 },
    ].map((row) => ({
      ...row,
      id: randomUUID(),
      tenantId: fx.tenantId,
      docType: "tenant:supplier_payment",
    })),
  });
  // Both issued numbers below 6, so the next is safe only on the higher one.
  expect(await next(fx)).toBe("PAY-00006");
  expect(await next(fx)).toBe("PAY-00007");
});

it("starts a tenant's first count on its earliest branch, ties broken by id", async () => {
  const fx = await createTenant(prisma, "doc-sequence-first");
  const branches = await prisma.branch.findMany({
    where: { tenantId: fx.tenantId },
    select: { id: true, createdAt: true },
  });
  const [first] = branches.sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1),
  );
  expect(await next(fx)).toBe("PAY-00001");
  expect(await holder(fx)).toEqual([first!.id]);
});
