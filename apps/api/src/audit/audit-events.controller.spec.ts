import { AuditEventsController } from "./audit-events.controller";
import { CRITICAL_AUDIT_EVENT_NAMES } from "./audit-taxonomy";
import { PrismaService } from "../prisma/prisma.service";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";

describe("AuditEventsController", () => {
  let prisma: {
    auditEvent: { findMany: jest.Mock; count: jest.Mock };
    product: { findMany: jest.Mock };
  };
  let controller: AuditEventsController;

  const user = { tenantId: "tenant-1" } as RequestUser;

  beforeEach(() => {
    prisma = {
      auditEvent: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      product: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    controller = new AuditEventsController(prisma as unknown as PrismaService);
  });

  it("scopes by tenant and applies default paging", async () => {
    await controller.list(user);

    const where = prisma.auditEvent.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ tenantId: "tenant-1" });
    expect(prisma.auditEvent.findMany.mock.calls[0][0]).toMatchObject({
      orderBy: { createdAt: "desc" },
      skip: 0,
      take: 25,
    });
  });

  it("caps take at 100", async () => {
    await controller.list(user, "9999");
    expect(prisma.auditEvent.findMany.mock.calls[0][0].take).toBe(100);
  });

  it("builds an OR of eventName prefixes for a module filter", async () => {
    await controller.list(user, undefined, undefined, undefined, undefined, undefined, "purchasing");

    const and = prisma.auditEvent.findMany.mock.calls[0][0].where.AND;
    expect(and).toEqual([
      {
        OR: [
          { eventName: { startsWith: "purchase_order." } },
          { eventName: { startsWith: "goods_receipt." } },
        ],
      },
    ]);
  });

  it("ignores an unknown module key", async () => {
    await controller.list(
      user,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "not-a-real-module",
    );
    expect(prisma.auditEvent.findMany.mock.calls[0][0].where.AND).toBeUndefined();
  });

  it("filters to the critical event allowlist when severity=critical", async () => {
    await controller.list(
      user,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "critical",
    );

    const and = prisma.auditEvent.findMany.mock.calls[0][0].where.AND;
    expect(and[0].eventName.in).toEqual(Array.from(CRITICAL_AUDIT_EVENT_NAMES));
  });

  it("searches eventName, entityName, and actor name/email for a free-text query", async () => {
    await controller.list(
      user,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "nadeeka",
    );

    const and = prisma.auditEvent.findMany.mock.calls[0][0].where.AND;
    expect(and[0].OR).toHaveLength(4);
  });

  it("marks each returned row as critical or not using the shared allowlist", async () => {
    prisma.auditEvent.findMany.mockResolvedValue([
      { id: "1", eventName: "sale.voided" },
      { id: "2", eventName: "product.created" },
    ]);

    const result = await controller.list(user);

    expect(result.items).toEqual([
      { id: "1", eventName: "sale.voided", critical: true, entityLabel: null },
      { id: "2", eventName: "product.created", critical: false, entityLabel: null },
    ]);
    expect(result.total).toBe(0);
  });

  it("resolves a human-readable entityLabel via one batched lookup per entity type", async () => {
    prisma.auditEvent.findMany.mockResolvedValue([
      { id: "1", eventName: "product.updated", entityName: "product", entityId: "prod-1" },
      { id: "2", eventName: "product.created", entityName: "product", entityId: "prod-2" },
    ]);
    prisma.product.findMany.mockResolvedValue([
      { id: "prod-1", name: "Panadol 500mg" },
      { id: "prod-2", name: "Amoxicillin 250mg" },
    ]);

    const result = await controller.list(user);

    expect(prisma.product.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.product.findMany).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1", id: { in: ["prod-1", "prod-2"] } },
      select: { id: true, name: true },
    });
    expect(result.items.map((i: { entityLabel: string | null }) => i.entityLabel)).toEqual([
      "Panadol 500mg",
      "Amoxicillin 250mg",
    ]);
  });
});
