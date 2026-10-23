import { randomUUID } from "node:crypto";
import { Prisma, RoleName } from "@prisma/client";
import { AuditService } from "../../src/audit/audit.service";
import { AccessService } from "../../src/security/access.service";
import { ManagementApprovalsService } from "../../src/security/management-approvals.service";
import type { ApprovalAction } from "../../src/security/approval-documents";
import type { RequestUser } from "../../src/security/interfaces/authenticated-request.interface";
import { createPrisma, createTenant, type TenantFixture } from "./fixtures";

const prisma = createPrisma();
const audit = new AuditService(prisma as never);
const access = new AccessService(prisma as never, {} as never);
const approvals = new ManagementApprovalsService(access, audit);
const tx = <T>(run: (client: Prisma.TransactionClient) => Promise<T>) =>
  prisma.$transaction(run, { timeout: 15_000 });
let fx: TenantFixture;
let owner: RequestUser;
let manager: RequestUser;
const actions: ApprovalAction[] = [
  "purchase_order.receive",
  "transfer.ship",
  "goods_return.complete",
];
const user = (id: string): RequestUser => ({
  tenantId: fx.tenantId,
  userId: id,
  tokenVersion: 0,
  branchRoles: [],
  email: "approval@test.invalid",
  fullName: "Approval actor",
  authMethod: "bearer",
});

async function document(action: ApprovalAction) {
  const common = { tenantId: fx.tenantId, branchId: fx.mainBranchId };
  if (action === "purchase_order.receive")
    return prisma.purchaseOrder.create({
      data: {
        ...common,
        supplierId: fx.supplierId,
        poNumber: randomUUID(),
        status: "issued",
        createdBy: fx.clerkId,
        items: {
          create: {
            tenantId: fx.tenantId,
            productId: fx.productId,
            orderedQty: 10,
            unitCost: "100.00",
          },
        },
      },
    });
  if (action === "transfer.ship")
    return prisma.transfer.create({
      data: {
        tenantId: fx.tenantId,
        fromBranchId: fx.mainBranchId,
        toBranchId: fx.otherBranchId,
        transferNumber: randomUUID(),
        status: "approved",
        requestedBy: fx.clerkId,
        items: {
          create: { tenantId: fx.tenantId, productId: fx.productId, qty: 10 },
        },
      },
    });
  return prisma.goodsReturn.create({
    data: {
      ...common,
      type: "supplier",
      supplierId: fx.supplierId,
      returnNumber: randomUUID(),
      status: "awaiting_logistics",
      requestedBy: fx.clerkId,
      amount: "1000.00",
      items: {
        create: {
          tenantId: fx.tenantId,
          productId: fx.productId,
          qty: 10,
          unitPrice: "100.00",
        },
      },
    },
  });
}
async function issued(
  action: ApprovalAction = "purchase_order.receive",
  actor = owner,
) {
  const doc = await document(action);
  const preview = await tx((c) =>
    approvals.preview(c, actor, fx.mainBranchId, action, doc.id),
  );
  const input = {
    approvalId: randomUUID(),
    expectedVersion: preview.identity.documentVersion,
    expectedDigest: preview.identity.documentDigest,
    reason: "Reviewed exact material",
    expiresAt: null as number | null,
  };
  const approval = await tx((c) =>
    approvals.issue(c, actor, fx.mainBranchId, action, doc.id, input),
  );
  return { doc, preview, input, approval, action };
}
const use = (p: Awaited<ReturnType<typeof issued>>) =>
  tx((c) =>
    approvals.requireForExecution(
      c,
      owner,
      fx.mainBranchId,
      p.action,
      p.doc.id,
      p.approval.approvalId,
    ),
  );
beforeAll(async () => {
  fx = await createTenant(prisma, "approvals");
  owner = user(fx.ownerId);
  manager = user(fx.managerId);
  await prisma.userBranchRole.createMany({
    data: [
      {
        tenantId: fx.tenantId,
        branchId: fx.mainBranchId,
        userId: fx.ownerId,
        role: RoleName.owner,
      },
      {
        tenantId: fx.tenantId,
        branchId: fx.mainBranchId,
        userId: fx.managerId,
        role: RoleName.manager,
      },
    ],
  });
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await prisma.$disconnect();
});

describe("P1 persisted exact material approvals", () => {
  it("rechecks the approver after a real approval-row lock wait", async () => {
    const p = await issued("transfer.ship", manager);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready!: (pid: number) => void;
    const locked = new Promise<number>((resolve) => {
      ready = resolve;
    });
    const blocker = tx(async (c) => {
      const [{ pid }] = await c.$queryRaw<
        { pid: number }[]
      >`SELECT pg_backend_pid() AS pid`;
      await c.$queryRaw`SELECT id FROM management_approval WHERE tenant_id = ${fx.tenantId}::uuid AND id = ${p.approval.approvalId}::uuid FOR UPDATE`;
      ready(pid);
      await gate;
    });
    let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      const blockerPid = await Promise.race([
        locked,
        blocker.then(() => {
          throw new Error("Lock holder exited");
        }),
      ]);
      let started!: (pid: number) => void;
      const operationPid = new Promise<number>((resolve) => {
        started = resolve;
      });
      pending = Promise.allSettled([
        tx(async (c) => {
          const [{ pid }] = await c.$queryRaw<
            { pid: number }[]
          >`SELECT pg_backend_pid() AS pid`;
          started(pid);
          return approvals.requireForExecution(
            c,
            owner,
            fx.mainBranchId,
            p.action,
            p.doc.id,
            p.approval.approvalId,
          );
        }),
      ]);
      const pid = await operationPid;
      const deadline = Date.now() + 10_000;
      for (;;) {
        const [{ blocked }] = await prisma.$queryRaw<
          { blocked: boolean }[]
        >`SELECT ${blockerPid}::int = ANY(pg_blocking_pids(${pid}::int)) AS blocked`;
        if (blocked) break;
        if (Date.now() > deadline)
          throw new Error("Expected approval-row lock wait");
      }
      await prisma.userBranchRole.updateMany({
        where: {
          tenantId: fx.tenantId,
          branchId: fx.mainBranchId,
          userId: manager.userId,
        },
        data: { role: "cashier" },
      });
      release();
      await blocker;
      const [result] = await pending;
      expect(result.status).toBe("rejected");
      if (result.status === "rejected")
        expect(result.reason.response.code).toBe("APPROVAL_INVALID");
    } finally {
      release();
      try {
        await blocker;
      } finally {
        if (pending) await pending;
      }
      await prisma.userBranchRole.updateMany({
        where: {
          tenantId: fx.tenantId,
          branchId: fx.mainBranchId,
          userId: manager.userId,
        },
        data: { role: "manager" },
      });
    }
  });

  it.each(actions)(
    "permits remote approval and exact scoped use for %s without posting effects",
    async (action) => {
      const ledgerBefore = await prisma.stockLedger.count({
        where: { tenantId: fx.tenantId },
      });
      const p = await issued(action);
      expect(await use(p)).toEqual(p.approval);
      expect(p.approval.document.requestedByUserId).toBe(fx.clerkId);
      expect(p.approval.approvedByUserId).toBe(owner.userId);
      expect(p.approval.expiresAt).toBeNull();
      expect(
        await prisma.stockLedger.count({ where: { tenantId: fx.tenantId } }),
      ).toBe(ledgerBefore);
      expect(
        await prisma.auditEvent.count({
          where: {
            tenantId: fx.tenantId,
            entityId: p.approval.approvalId,
            eventName: "management_approval.issued",
          },
        }),
      ).toBe(1);
    },
  );

  it("concurrent approval retries create one immutable evidence and success audit", async () => {
    const p = await issued();
    const results = await Promise.all(
      [1, 2].map(() =>
        tx((c) =>
          approvals.issue(
            c,
            owner,
            fx.mainBranchId,
            p.action,
            p.doc.id,
            p.input,
          ),
        ),
      ),
    );
    expect(results).toEqual([p.approval, p.approval]);
    expect(
      await prisma.auditEvent.count({
        where: { tenantId: fx.tenantId, entityId: p.approval.approvalId },
      }),
    ).toBe(1);
    await expect(
      tx((c) =>
        approvals.issue(c, owner, fx.mainBranchId, p.action, p.doc.id, {
          ...p.input,
          reason: "Different request",
        }),
      ),
    ).rejects.toThrow();
  });

  it.each(actions)(
    "notes retain approval and advance only metadata for %s",
    async (action) => {
      const p = await issued(action);
      const where = { tenantId: fx.tenantId, id: p.doc.id };
      if (action === "purchase_order.receive")
        await prisma.purchaseOrder.update({
          where,
          data: { notes: "Delivery contact called" },
        });
      else if (action === "transfer.ship")
        await prisma.transfer.update({
          where,
          data: { notes: "Driver called" },
        });
      else
        await prisma.goodsReturn.update({
          where,
          data: { notes: "Courier called" },
        });
      const current = await tx((c) =>
        approvals.preview(c, owner, fx.mainBranchId, action, p.doc.id),
      );
      expect(current.identity).toEqual(p.preview.identity);
      const metadata =
        action === "purchase_order.receive"
          ? await prisma.purchaseOrder.findFirstOrThrow({ where })
          : action === "transfer.ship"
            ? await prisma.transfer.findFirstOrThrow({ where })
            : await prisma.goodsReturn.findFirstOrThrow({ where });
      expect(metadata.metadataVersion).toBe(p.doc.metadataVersion + 1);
      expect(await use(p)).toEqual(p.approval);
    },
  );

  it("partial receipt counters do not rewrite approved material or revision", async () => {
    const p = await issued();
    await prisma.purchaseOrderItem.updateMany({
      where: { tenantId: fx.tenantId, purchaseOrderId: p.doc.id },
      data: { receivedQty: 2, freeQty: 1, rejectedQty: 1 },
    });
    await prisma.purchaseOrder.update({
      where: { tenantId: fx.tenantId, id: p.doc.id },
      data: { status: "partially_received" },
    });
    expect(await use(p)).toEqual(p.approval);
  });

  it.each(actions)(
    "material line changes invalidate %s, even when restored to the old value",
    async (action) => {
      const p = await issued(action);
      if (action === "purchase_order.receive") {
        for (const orderedQty of [11, 10])
          await prisma.purchaseOrderItem.updateMany({
            where: { tenantId: fx.tenantId, purchaseOrderId: p.doc.id },
            data: { orderedQty },
          });
      } else if (action === "transfer.ship") {
        for (const qty of [11, 10])
          await prisma.transferItem.updateMany({
            where: { tenantId: fx.tenantId, transferId: p.doc.id },
            data: { qty },
          });
      } else {
        for (const qty of [11, 10])
          await prisma.goodsReturnItem.updateMany({
            where: { tenantId: fx.tenantId, returnId: p.doc.id },
            data: { qty },
          });
      }
      const current = await tx((c) =>
        approvals.preview(c, owner, fx.mainBranchId, action, p.doc.id),
      );
      expect(current.identity.documentDigest).toBe(
        p.preview.identity.documentDigest,
      );
      expect(current.identity.documentVersion).toBe(
        p.preview.identity.documentVersion + 2,
      );
      await expect(use(p)).rejects.toMatchObject({
        response: { code: "APPROVAL_STALE" },
      });
    },
  );

  it("header prices/destination and line insert/delete are material; version rollback is denied", async () => {
    const po = await issued();
    await prisma.purchaseOrder.update({
      where: { tenantId: fx.tenantId, id: po.doc.id },
      data: { shippingCharges: "1.00" },
    });
    await expect(use(po)).rejects.toThrow();
    await expect(
      prisma.purchaseOrder.update({
        where: { tenantId: fx.tenantId, id: po.doc.id },
        data: { approvalVersion: 1 },
      }),
    ).rejects.toThrow();
    const transfer = await issued("transfer.ship");
    await prisma.transfer.update({
      where: { tenantId: fx.tenantId, id: transfer.doc.id },
      data: { toBranchId: fx.mainBranchId },
    });
    await expect(use(transfer)).rejects.toThrow();
    const ret = await issued("goods_return.complete");
    await prisma.goodsReturnItem.deleteMany({
      where: { tenantId: fx.tenantId, returnId: ret.doc.id },
    });
    await prisma.goodsReturnItem.create({
      data: {
        tenantId: fx.tenantId,
        returnId: ret.doc.id,
        productId: fx.productId,
        qty: 10,
        unitPrice: "100.00",
      },
    });
    await expect(use(ret)).rejects.toThrow();
  });

  it("rejects a preview made stale before the manager approves", async () => {
    const p = await issued();
    await prisma.purchaseOrderItem.updateMany({
      where: { tenantId: fx.tenantId, purchaseOrderId: p.doc.id },
      data: { unitCost: "101.00" },
    });
    const approvalId = randomUUID();
    await expect(
      tx((c) =>
        approvals.issue(c, owner, fx.mainBranchId, p.action, p.doc.id, {
          ...p.input,
          approvalId,
        }),
      ),
    ).rejects.toMatchObject({ response: { code: "APPROVAL_STALE" } });
    expect(
      await prisma.managementApproval.count({
        where: { tenantId: fx.tenantId, id: approvalId },
      }),
    ).toBe(0);
  });

  it("cannot cross branch, tenant, action or document identities", async () => {
    const p = await issued();
    const other = await document(p.action);
    for (const [actor, branchId, action, id] of [
      [owner, fx.otherBranchId, p.action, p.doc.id],
      [
        { ...owner, tenantId: randomUUID() },
        fx.mainBranchId,
        p.action,
        p.doc.id,
      ],
      [owner, fx.mainBranchId, "transfer.ship", p.doc.id],
      [owner, fx.mainBranchId, p.action, other.id],
    ] as const)
      await expect(
        tx((c) =>
          approvals.requireForExecution(
            c,
            actor,
            branchId,
            action,
            id,
            p.approval.approvalId,
          ),
        ),
      ).rejects.toThrow();
  });

  it("rechecks approver rights, membership and current self-approval rules", async () => {
    const p = await issued("transfer.ship", manager);
    await prisma.appUser.update({
      where: { id: manager.userId },
      data: { tokenVersion: { increment: 1 } },
    });
    // Logout does not erase a valid document approval; rights, not its old login, are checked.
    expect(await use(p)).toEqual(p.approval);
    await prisma.tenantMembership.updateMany({
      where: { tenantId: fx.tenantId, userId: manager.userId },
      data: { isActive: false },
    });
    try {
      await expect(use(p)).rejects.toMatchObject({
        response: { code: "APPROVAL_INVALID" },
      });
    } finally {
      await prisma.tenantMembership.updateMany({
        where: { tenantId: fx.tenantId, userId: manager.userId },
        data: { isActive: true },
      });
    }
    await prisma.userBranchRole.updateMany({
      where: {
        tenantId: fx.tenantId,
        branchId: fx.mainBranchId,
        userId: manager.userId,
      },
      data: { role: "cashier" },
    });
    try {
      await expect(use(p)).rejects.toMatchObject({
        response: { code: "APPROVAL_INVALID" },
      });
    } finally {
      await prisma.userBranchRole.updateMany({
        where: {
          tenantId: fx.tenantId,
          branchId: fx.mainBranchId,
          userId: manager.userId,
        },
        data: { role: "manager" },
      });
    }
  });

  it("preserves configurable self-approval without imposing two different approver/executor people", async () => {
    const doc = await document("purchase_order.receive");
    await prisma.purchaseOrder.update({
      where: { tenantId: fx.tenantId, id: doc.id },
      data: { createdBy: owner.userId },
    });
    await prisma.tenantSettings.upsert({
      where: { tenantId: fx.tenantId },
      create: { tenantId: fx.tenantId, selfApprovalRoleKeys: [] },
      update: { selfApprovalRoleKeys: [] },
    });
    const preview = await tx((c) =>
      approvals.preview(
        c,
        owner,
        fx.mainBranchId,
        "purchase_order.receive",
        doc.id,
      ),
    );
    const input = {
      approvalId: randomUUID(),
      expectedVersion: preview.identity.documentVersion,
      expectedDigest: preview.identity.documentDigest,
      reason: "Owner review",
      expiresAt: null,
    };
    try {
      await expect(
        tx((c) =>
          approvals.issue(
            c,
            owner,
            fx.mainBranchId,
            "purchase_order.receive",
            doc.id,
            input,
          ),
        ),
      ).rejects.toThrow("can't approve its own");
      await prisma.tenantSettings.update({
        where: { tenantId: fx.tenantId },
        data: { selfApprovalRoleKeys: ["owner"] },
      });
      await tx((c) =>
        approvals.issue(
          c,
          owner,
          fx.mainBranchId,
          "purchase_order.receive",
          doc.id,
          input,
        ),
      );
      await tx((c) =>
        approvals.requireForExecution(
          c,
          owner,
          fx.mainBranchId,
          "purchase_order.receive",
          doc.id,
          input.approvalId,
        ),
      );
      await prisma.tenantSettings.update({
        where: { tenantId: fx.tenantId },
        data: { selfApprovalRoleKeys: [] },
      });
      await expect(
        tx((c) =>
          approvals.requireForExecution(
            c,
            owner,
            fx.mainBranchId,
            "purchase_order.receive",
            doc.id,
            input.approvalId,
          ),
        ),
      ).rejects.toMatchObject({ response: { code: "SELF_APPROVAL_DENIED" } });
    } finally {
      await prisma.tenantSettings.update({
        where: { tenantId: fx.tenantId },
        data: { selfApprovalRoleKeys: ["owner", "manager"] },
      });
    }
  });

  it("revocation and expiry deny new use while retaining immutable original evidence", async () => {
    const p = await issued();
    await tx((c) =>
      approvals.revoke(
        c,
        owner,
        fx.mainBranchId,
        p.approval.approvalId,
        "Withdrawn",
      ),
    );
    await expect(use(p)).rejects.toThrow();
    await expect(
      prisma.managementApproval.update({
        where: { id: p.approval.approvalId },
        data: { revokedAt: null, revocationReason: null },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.managementApproval.update({
        where: { id: p.approval.approvalId },
        data: { documentDigest: "a".repeat(64) },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.managementApproval.delete({
        where: { id: p.approval.approvalId },
      }),
    ).rejects.toThrow();
    const current = await tx((c) =>
      approvals.preview(c, owner, fx.mainBranchId, p.action, p.doc.id),
    );
    const expiring = await tx((c) =>
      approvals.issue(c, owner, fx.mainBranchId, p.action, p.doc.id, {
        ...p.input,
        approvalId: randomUUID(),
        expectedVersion: current.identity.documentVersion,
        expiresAt: Date.now() + 5_000,
      }),
    );
    jest.spyOn(Date, "now").mockReturnValue(expiring.expiresAt!);
    await expect(
      tx((c) =>
        approvals.requireForExecution(
          c,
          owner,
          fx.mainBranchId,
          p.action,
          p.doc.id,
          expiring.approvalId,
        ),
      ),
    ).rejects.toMatchObject({ response: { code: "APPROVAL_EXPIRED" } });
  });

  it("audit failure rolls back approval creation; downstream failure rolls back execution audit", async () => {
    const p = await issued();
    const id = randomUUID();
    jest
      .spyOn(audit, "log")
      .mockRejectedValueOnce(new Error("Audit unavailable"));
    await expect(
      tx((c) =>
        approvals.issue(c, owner, fx.mainBranchId, p.action, p.doc.id, {
          ...p.input,
          approvalId: id,
        }),
      ),
    ).rejects.toThrow("Audit unavailable");
    expect(
      await prisma.managementApproval.count({
        where: { tenantId: fx.tenantId, id },
      }),
    ).toBe(0);
    await tx((c) =>
      approvals.issue(c, owner, fx.mainBranchId, p.action, p.doc.id, {
        ...p.input,
        approvalId: id,
      }),
    );
    const executionId = randomUUID();
    await expect(
      tx(async (c) => {
        const approval = await approvals.requireForExecution(
          c,
          owner,
          fx.mainBranchId,
          p.action,
          p.doc.id,
          id,
        );
        await audit.log(
          {
            tenantId: fx.tenantId,
            branchId: fx.mainBranchId,
            actorUserId: owner.userId,
            eventName: "test.executed",
            entityName: "test",
            entityId: executionId,
            payload: {
              approvedByUserId: approval.approvedByUserId,
              requestedByUserId: approval.document.requestedByUserId,
              executedByUserId: owner.userId,
            },
          },
          c,
        );
        throw new Error("Execution failed");
      }),
    ).rejects.toThrow("Execution failed");
    expect(
      await prisma.auditEvent.count({
        where: { tenantId: fx.tenantId, entityId: executionId },
      }),
    ).toBe(0);
  });
});
