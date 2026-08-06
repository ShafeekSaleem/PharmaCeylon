import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

export type ProductFilterQuery = {
  q?: string;
  dosageForm?: string;
  brandName?: string;
  schedule?: string;
  isControlled?: string;
  /** When true, only products that require a prescription (or are controlled). */
  requiresPrescription?: boolean;
  status?: string;
  lowStock?: boolean;
  categoryId?: string;
  tagId?: string;
};

export type FacetExclude =
  | "dosageForm"
  | "brandName"
  | "schedule"
  | "status"
  | "isControlled"
  | "requiresPrescription";

export type ProductWhereResult = {
  where: Prisma.ProductWhereInput;
  isEmpty: boolean;
};

const EMPTY_WHERE = (tenantId: string): ProductWhereResult => ({
  where: { tenantId, id: { in: [] } },
  isEmpty: true,
});

export function parseCsv(value?: string): string[] {
  if (!value?.trim()) return [];
  return [...new Set(value.split(",").map((s) => s.trim()).filter(Boolean))];
}

/**
 * Branch-scoped low-stock ids: only products with positive ledger qty at the
 * branch are considered (avoids loading the full tenant catalog).
 */
export async function lowStockProductIds(
  prisma: PrismaService,
  tenantId: string,
  branchId: string,
): Promise<string[]> {
  const grouped = await prisma.stockLedger.groupBy({
    by: ["productId"],
    where: { tenantId, branchId },
    _sum: { qtyDelta: true },
  });
  const withStock = grouped.filter((g) => (g._sum.qtyDelta ?? 0) > 0);
  if (withStock.length === 0) return [];

  const qtyMap = new Map(withStock.map((g) => [g.productId, g._sum.qtyDelta ?? 0]));
  const products = await prisma.product.findMany({
    where: {
      tenantId,
      id: { in: withStock.map((g) => g.productId) },
      reorderLevel: { gt: 0 },
    },
    select: { id: true, reorderLevel: true },
  });

  const ids: string[] = [];
  for (const p of products) {
    const qty = qtyMap.get(p.id) ?? 0;
    if (qty > 0 && qty <= p.reorderLevel) {
      ids.push(p.id);
    }
  }
  return ids;
}

function resolveStatusFilter(
  statusValues: string[],
  statusParam?: string,
): Prisma.ProductWhereInput {
  if (statusValues.length === 1) {
    if (statusValues[0] === "inactive") return { isActive: false };
    if (statusValues[0] === "active") return { isActive: true };
    return {};
  }
  if (statusParam === "inactive") return { isActive: false };
  if (statusParam === "active") return { isActive: true };
  return {};
}

function resolveControlledFilter(
  controlledValues: string[],
  isControlledParam?: string,
): Prisma.ProductWhereInput {
  if (controlledValues.length === 1 && controlledValues[0] === "true") {
    return { isControlled: true };
  }
  if (controlledValues.length === 1 && controlledValues[0] === "false") {
    return { isControlled: false };
  }
  if (isControlledParam === "true") return { isControlled: true };
  if (isControlledParam === "false") return { isControlled: false };
  return {};
}

/** Controlled products should also have this flag set (enforced on write). */
function resolveRequiresPrescriptionFilter(
  requiresPrescription?: boolean,
): Prisma.ProductWhereInput {
  if (!requiresPrescription) return {};
  return { requiresPrescription: true };
}

export async function buildProductWhere(
  prisma: PrismaService,
  tenantId: string,
  branchId: string | undefined,
  query: ProductFilterQuery,
  exclude?: FacetExclude,
): Promise<ProductWhereResult> {
  const dosageForms = parseCsv(query.dosageForm);
  const brandNames = parseCsv(query.brandName);
  const schedules = parseCsv(query.schedule);
  const statusValues = parseCsv(query.status);
  const controlledValues = parseCsv(query.isControlled);
  const categoryIds = parseCsv(query.categoryId);
  const tagIds = parseCsv(query.tagId);

  let lowStockIds: string[] | undefined;
  if (query.lowStock) {
    if (!branchId) {
      return EMPTY_WHERE(tenantId);
    }
    lowStockIds = await lowStockProductIds(prisma, tenantId, branchId);
    if (lowStockIds.length === 0) {
      return EMPTY_WHERE(tenantId);
    }
  }

  const where: Prisma.ProductWhereInput = {
    tenantId,
    ...(exclude !== "status"
      ? resolveStatusFilter(statusValues, query.status)
      : {}),
    ...(exclude !== "dosageForm"
      ? dosageForms.length === 1
        ? { dosageForm: dosageForms[0] }
        : dosageForms.length > 1
          ? { dosageForm: { in: dosageForms } }
          : {}
      : {}),
    ...(exclude !== "brandName"
      ? brandNames.length === 1
        ? { brandName: brandNames[0] }
        : brandNames.length > 1
          ? { brandName: { in: brandNames } }
          : {}
      : {}),
    ...(exclude !== "schedule"
      ? schedules.length === 1
        ? { schedule: schedules[0] }
        : schedules.length > 1
          ? { schedule: { in: schedules } }
          : {}
      : {}),
    ...(exclude !== "isControlled"
      ? resolveControlledFilter(controlledValues, query.isControlled)
      : {}),
    ...(exclude !== "requiresPrescription"
      ? resolveRequiresPrescriptionFilter(query.requiresPrescription)
      : {}),
    ...(lowStockIds ? { id: { in: lowStockIds } } : {}),
    ...(categoryIds.length === 1
      ? { categoryMaps: { some: { tenantId, categoryId: categoryIds[0] } } }
      : categoryIds.length > 1
        ? { categoryMaps: { some: { tenantId, categoryId: { in: categoryIds } } } }
        : {}),
    ...(tagIds.length === 1
      ? { tagMaps: { some: { tenantId, tagId: tagIds[0] } } }
      : tagIds.length > 1
        ? { tagMaps: { some: { tenantId, tagId: { in: tagIds } } } }
        : {}),
    ...(query.q?.trim()
      ? {
          OR: [
            { name: { contains: query.q.trim(), mode: "insensitive" } },
            { sku: { contains: query.q.trim(), mode: "insensitive" } },
            { barcode: { contains: query.q.trim(), mode: "insensitive" } },
            { brandName: { contains: query.q.trim(), mode: "insensitive" } },
            { genericName: { contains: query.q.trim(), mode: "insensitive" } },
            { registrationNo: { contains: query.q.trim(), mode: "insensitive" } },
            { dossierNo: { contains: query.q.trim(), mode: "insensitive" } },
            {
              aliases: {
                some: {
                  tenantId,
                  aliasText: { contains: query.q.trim(), mode: "insensitive" },
                },
              },
            },
          ],
        }
      : {}),
  };

  return { where, isEmpty: false };
}
