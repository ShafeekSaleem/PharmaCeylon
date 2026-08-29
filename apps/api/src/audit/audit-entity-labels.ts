import { PrismaService } from "../prisma/prisma.service";

type EntityRef = { entityName: string; entityId: string };

/**
 * Resolves a human-readable label for each distinct (entityName, entityId) pair on a page
 * of audit events — a product's name, a purchase order's PO number, a user's full name, etc.
 * — so the UI never has to show a raw UUID for something a viewer would recognize by name.
 * Only runs one batched, indexed lookup per entity type actually present on the page (never
 * one query per row), and every lookup is scoped to the caller's tenant.
 */
export async function resolveAuditEntityLabels(
  prisma: PrismaService,
  tenantId: string,
  items: EntityRef[],
): Promise<Map<string, string>> {
  const idsByEntity = new Map<string, Set<string>>();
  for (const item of items) {
    if (!idsByEntity.has(item.entityName)) idsByEntity.set(item.entityName, new Set());
    idsByEntity.get(item.entityName)!.add(item.entityId);
  }

  const lookups: {
    entityName: string;
    fetch: (ids: string[]) => Promise<{ id: string; label: string }[]>;
  }[] = [
    {
      entityName: "product",
      fetch: (ids) =>
        prisma.product
          .findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, name: true } })
          .then((rows) => rows.map((r) => ({ id: r.id, label: r.name }))),
    },
    {
      entityName: "batch",
      fetch: (ids) =>
        prisma.batch
          .findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, batchNo: true } })
          .then((rows) => rows.map((r) => ({ id: r.id, label: r.batchNo }))),
    },
    {
      entityName: "purchase_order",
      fetch: (ids) =>
        prisma.purchaseOrder
          .findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, poNumber: true } })
          .then((rows) => rows.map((r) => ({ id: r.id, label: r.poNumber }))),
    },
    {
      entityName: "goods_receipt",
      fetch: (ids) =>
        prisma.goodsReceipt
          .findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, grnNumber: true } })
          .then((rows) => rows.map((r) => ({ id: r.id, label: r.grnNumber }))),
    },
    {
      entityName: "goods_return",
      fetch: (ids) =>
        prisma.goodsReturn
          .findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, returnNumber: true } })
          .then((rows) => rows.map((r) => ({ id: r.id, label: r.returnNumber }))),
    },
    {
      entityName: "supplier",
      fetch: (ids) =>
        prisma.supplier
          .findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, name: true } })
          .then((rows) => rows.map((r) => ({ id: r.id, label: r.name }))),
    },
    {
      entityName: "supplier_invoice",
      fetch: (ids) =>
        prisma.supplierInvoice
          .findMany({
            where: { tenantId, id: { in: ids } },
            select: { id: true, invoiceNumber: true },
          })
          .then((rows) => rows.map((r) => ({ id: r.id, label: r.invoiceNumber }))),
    },
    {
      entityName: "stocktake",
      fetch: (ids) =>
        prisma.stocktake
          .findMany({
            where: { tenantId, id: { in: ids } },
            select: { id: true, stocktakeNumber: true },
          })
          .then((rows) => rows.map((r) => ({ id: r.id, label: r.stocktakeNumber }))),
    },
    {
      entityName: "sale",
      fetch: (ids) =>
        prisma.sale
          .findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, invoiceNo: true } })
          .then((rows) => rows.map((r) => ({ id: r.id, label: r.invoiceNo }))),
    },
    {
      entityName: "transfer",
      fetch: (ids) =>
        prisma.transfer
          .findMany({
            where: { tenantId, id: { in: ids } },
            select: { id: true, transferNumber: true },
          })
          .then((rows) => rows.map((r) => ({ id: r.id, label: r.transferNumber }))),
    },
    {
      entityName: "app_user",
      fetch: (ids) =>
        prisma.appUser
          .findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, fullName: true } })
          .then((rows) => rows.map((r) => ({ id: r.id, label: r.fullName }))),
    },
    {
      entityName: "role",
      fetch: (ids) =>
        prisma.role
          .findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, name: true } })
          .then((rows) => rows.map((r) => ({ id: r.id, label: r.name }))),
    },
    {
      entityName: "branch",
      fetch: (ids) =>
        prisma.branch
          .findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, name: true } })
          .then((rows) => rows.map((r) => ({ id: r.id, label: r.name }))),
    },
    {
      entityName: "tenant",
      fetch: (ids) =>
        prisma.tenant
          .findMany({
            where: { id: { in: ids.filter((id) => id === tenantId) } },
            select: { id: true, displayName: true },
          })
          .then((rows) => rows.map((r) => ({ id: r.id, label: r.displayName }))),
    },
  ];

  const labels = new Map<string, string>();
  await Promise.all(
    lookups.map(async ({ entityName, fetch }) => {
      const ids = [...(idsByEntity.get(entityName) ?? [])];
      if (ids.length === 0) return;
      const rows = await fetch(ids);
      for (const row of rows) labels.set(`${entityName}:${row.id}`, row.label);
    }),
  );

  return labels;
}
