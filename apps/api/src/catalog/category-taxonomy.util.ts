import { ConflictException, NotFoundException } from "@nestjs/common";
import { CategoryAssignmentSource, CategoryDimension, Prisma, PrismaClient } from "@prisma/client";
import {
  COMMERCIAL_CATEGORY_TEMPLATE,
  ONBOARDING_DEPARTMENT_GROUPS,
  UNCLASSIFIED_MEDICINES_CANONICAL_KEY,
} from "./commercial-category-template";
import { classifyMedicine } from "./deterministic-medicine-classifier";

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export type RegulatoryDimension = Exclude<CategoryDimension, "COMMERCIAL">;

const DIMENSION_ROOT_NAME: Record<RegulatoryDimension, string> = {
  DOSAGE_FORM: "Dosage form",
  NMRA_SCHEDULE: "NMRA Schedule",
  REGISTRATION_TYPE: "Registration type",
};

/**
 * Single source of truth for category/classification semantics. Replaces the previous
 * pattern of services matching on category display name (e.g. `name === "Dosage form"`)
 * with explicit `dimension` / `canonicalKey` lookups, so renaming a category never breaks
 * reporting or NMRA taxonomy resolution.
 *
 * Plain class over a bare `PrismaClient` (not a Nest `@Injectable`) so the same logic is
 * reusable from both the Nest app (via `CategoryTaxonomyService`, its thin DI wrapper) and
 * standalone scripts (seed/backfill) that construct their own `PrismaClient`.
 */
export class CategoryTaxonomyOps {
  constructor(protected readonly prisma: PrismaClient) {}

  /** Ensure the root category for a regulatory dimension exists; returns its id. Idempotent. */
  async ensureDimensionRoot(tenantId: string, dimension: RegulatoryDimension): Promise<string> {
    const existing = await this.prisma.productCategory.findFirst({
      where: { tenantId, dimension, parentCategoryId: null },
      select: { id: true },
    });
    if (existing) return existing.id;
    const created = await this.prisma.productCategory.create({
      data: {
        tenantId,
        dimension,
        name: DIMENSION_ROOT_NAME[dimension],
        parentCategoryId: null,
        source: "NMRA_IMPORT",
        isSystem: true,
      },
    });
    return created.id;
  }

  /** All three regulatory dimension root ids in one query — avoids N+1 across the three ensures. */
  async dimensionRootIds(tenantId: string): Promise<Record<RegulatoryDimension, string | null>> {
    const rows = await this.prisma.productCategory.findMany({
      where: {
        tenantId,
        parentCategoryId: null,
        dimension: { in: ["DOSAGE_FORM", "NMRA_SCHEDULE", "REGISTRATION_TYPE"] },
      },
      select: { id: true, dimension: true },
    });
    const byDimension: Record<RegulatoryDimension, string | null> = {
      DOSAGE_FORM: null,
      NMRA_SCHEDULE: null,
      REGISTRATION_TYPE: null,
    };
    for (const row of rows) {
      byDimension[row.dimension as RegulatoryDimension] = row.id;
    }
    return byDimension;
  }

  /** The commercial department/category tree's category ids, keyed by canonicalKey. */
  async commercialCanonicalIds(tenantId: string): Promise<Map<string, string>> {
    const rows = await this.prisma.productCategory.findMany({
      where: { tenantId, dimension: "COMMERCIAL", canonicalKey: { not: null } },
      select: { id: true, canonicalKey: true },
    });
    return new Map(rows.map((r) => [r.canonicalKey!, r.id]));
  }

  /**
   * Seed the standard commercial merchandising taxonomy for a tenant (idempotent — matched
   * by canonicalKey, safe to rerun). Departments marked `enabledByDefault` in the template
   * (Medicines) are created active; everything else is created inactive until the tenant
   * opts in via onboarding or Settings → Catalog → Categories.
   */
  async ensureCommercialTemplate(tenantId: string): Promise<void> {
    const existingByKey = await this.commercialCanonicalIds(tenantId);
    let sortOrder = 0;
    for (const dept of COMMERCIAL_CATEGORY_TEMPLATE) {
      sortOrder += 1;
      let deptId = existingByKey.get(dept.canonicalKey);
      if (!deptId) {
        const created = await this.prisma.productCategory.create({
          data: {
            tenantId,
            dimension: "COMMERCIAL",
            name: dept.name,
            parentCategoryId: null,
            canonicalKey: dept.canonicalKey,
            source: "SYSTEM_TEMPLATE",
            isSystem: true,
            isActive: dept.enabledByDefault ?? false,
            sortOrder,
          },
        });
        deptId = created.id;
        existingByKey.set(dept.canonicalKey, deptId);
      }

      let childSort = 0;
      for (const child of dept.children ?? []) {
        childSort += 1;
        if (existingByKey.has(child.canonicalKey)) continue;
        const created = await this.prisma.productCategory.create({
          data: {
            tenantId,
            dimension: "COMMERCIAL",
            name: child.name,
            parentCategoryId: deptId,
            canonicalKey: child.canonicalKey,
            source: "SYSTEM_TEMPLATE",
            isSystem: true,
            isActive: dept.enabledByDefault ?? false,
            sortOrder: childSort,
          },
        });
        existingByKey.set(child.canonicalKey, created.id);
      }
    }
  }

  /** Enable/disable a department + all its descendant categories (cascades one level of hierarchy at a time). */
  async setDepartmentEnabled(tenantId: string, canonicalKey: string, isActive: boolean): Promise<void> {
    const dept = await this.prisma.productCategory.findFirst({
      where: { tenantId, dimension: "COMMERCIAL", canonicalKey },
      select: { id: true },
    });
    if (!dept) throw new NotFoundException(`Unknown department canonicalKey: ${canonicalKey}`);
    await this.prisma.$transaction([
      this.prisma.productCategory.update({ where: { id: dept.id, tenantId }, data: { isActive } }),
      this.prisma.productCategory.updateMany({
        where: { tenantId, parentCategoryId: dept.id },
        data: { isActive },
      }),
    ]);
  }

  /** Apply the onboarding "what does your pharmacy sell" selection — enables the chosen department groups. */
  async applyOnboardingSelection(tenantId: string, selectedLabels: string[]): Promise<void> {
    await this.ensureCommercialTemplate(tenantId);
    const selected = new Set(selectedLabels);
    for (const group of ONBOARDING_DEPARTMENT_GROUPS) {
      if (!selected.has(group.label)) continue;
      for (const departmentKey of group.departmentKeys) {
        await this.setDepartmentEnabled(tenantId, departmentKey, true);
      }
    }
  }

  /**
   * Product → category name/id for a single regulatory dimension, batched (no N+1). Each
   * product is expected to have at most one map per regulatory dimension.
   */
  async regulatoryCategoryByProductIds(
    tenantId: string,
    productIds: string[],
    dimension: RegulatoryDimension,
  ): Promise<Map<string, { id: string; name: string }>> {
    if (productIds.length === 0) return new Map();
    const maps = await this.prisma.productCategoryMap.findMany({
      where: { tenantId, productId: { in: productIds }, dimension },
      select: { productId: true, category: { select: { id: true, name: true } } },
    });
    return new Map(maps.map((m) => [m.productId, m.category]));
  }

  /** Product → primary COMMERCIAL category, batched (no N+1). Used by reports/Products/POS. */
  async primaryCommercialCategoryByProductIds(
    tenantId: string,
    productIds: string[],
  ): Promise<
    Map<
      string,
      {
        id: string;
        name: string;
        parentCategoryId: string | null;
        canonicalKey: string | null;
        parent: { id: string; name: string } | null;
      }
    >
  > {
    if (productIds.length === 0) return new Map();
    const maps = await this.prisma.productCategoryMap.findMany({
      where: { tenantId, productId: { in: productIds }, dimension: "COMMERCIAL", isPrimary: true },
      select: {
        productId: true,
        category: {
          select: {
            id: true,
            name: true,
            parentCategoryId: true,
            canonicalKey: true,
            parent: { select: { id: true, name: true } },
          },
        },
      },
    });
    return new Map(maps.map((m) => [m.productId, m.category]));
  }

  /**
   * Set (or move) a product's single primary COMMERCIAL category. Enforces the "at most one
   * primary COMMERCIAL category per product" invariant at the service layer (mirrored by a
   * partial unique DB index — see migration SQL). Throws if `categoryId` isn't a COMMERCIAL
   * category in this tenant.
   */
  async setPrimaryCommercialCategory(
    tenantId: string,
    productId: string,
    categoryId: string,
    opts?: { assignmentSource?: CategoryAssignmentSource; confidence?: number },
  ): Promise<void> {
    const category = await this.prisma.productCategory.findFirst({
      where: { id: categoryId, tenantId },
      select: { id: true, dimension: true },
    });
    if (!category) throw new NotFoundException("Category not found");
    if (category.dimension !== "COMMERCIAL") {
      throw new ConflictException("Only a COMMERCIAL category can be a product's primary category");
    }

    await this.prisma.$transaction([
      this.prisma.productCategoryMap.updateMany({
        where: {
          tenantId,
          productId,
          dimension: "COMMERCIAL",
          isPrimary: true,
          categoryId: { not: categoryId },
        },
        data: { isPrimary: false },
      }),
      this.prisma.productCategoryMap.upsert({
        where: { tenantId_productId_categoryId: { tenantId, productId, categoryId } },
        create: {
          tenantId,
          productId,
          categoryId,
          dimension: "COMMERCIAL",
          isPrimary: true,
          assignmentSource: opts?.assignmentSource ?? "MANUAL",
          confidence: opts?.confidence,
        },
        update: {
          isPrimary: true,
          assignmentSource: opts?.assignmentSource ?? "MANUAL",
          confidence: opts?.confidence,
        },
      }),
    ]);
  }

  /** Add a non-primary COMMERCIAL category association for discovery (never used for financial reporting). */
  async addSecondaryCommercialCategory(tenantId: string, productId: string, categoryId: string): Promise<void> {
    const category = await this.prisma.productCategory.findFirst({
      where: { id: categoryId, tenantId },
      select: { id: true, dimension: true },
    });
    if (!category) throw new NotFoundException("Category not found");
    if (category.dimension !== "COMMERCIAL") {
      throw new ConflictException("Only a COMMERCIAL category can be added as a secondary category");
    }
    await this.prisma.productCategoryMap.upsert({
      where: { tenantId_productId_categoryId: { tenantId, productId, categoryId } },
      create: {
        tenantId,
        productId,
        categoryId,
        dimension: "COMMERCIAL",
        isPrimary: false,
        assignmentSource: "MANUAL",
      },
      update: {},
    });
  }

  async removeCategoryMap(tenantId: string, productId: string, categoryId: string): Promise<void> {
    await this.prisma.productCategoryMap.deleteMany({ where: { tenantId, productId, categoryId } });
  }

  /**
   * Bulk-assign every product missing a primary COMMERCIAL category to the given canonicalKey
   * (used for the "Medicines → Unclassified Medicines" safety net). Idempotent — only touches
   * products that don't already have a primary COMMERCIAL map. Returns the number assigned.
   */
  async assignMissingPrimaryCommercial(
    tenantId: string,
    productIds: string[],
    fallbackCanonicalKey: string,
    assignmentSource: CategoryAssignmentSource = "SYSTEM_DEFAULT",
  ): Promise<number> {
    if (productIds.length === 0) return 0;
    const fallback = await this.prisma.productCategory.findFirst({
      where: { tenantId, dimension: "COMMERCIAL", canonicalKey: fallbackCanonicalKey },
      select: { id: true },
    });
    if (!fallback) {
      throw new NotFoundException(
        `Commercial fallback category ${fallbackCanonicalKey} not seeded for tenant`,
      );
    }

    const alreadyMapped = await this.prisma.productCategoryMap.findMany({
      where: { tenantId, productId: { in: productIds }, dimension: "COMMERCIAL", isPrimary: true },
      select: { productId: true },
    });
    const mappedIds = new Set(alreadyMapped.map((m) => m.productId));
    const missingIds = productIds.filter((id) => !mappedIds.has(id));
    if (missingIds.length === 0) return 0;

    const data: Prisma.ProductCategoryMapCreateManyInput[] = missingIds.map((productId) => ({
      tenantId,
      productId,
      categoryId: fallback.id,
      dimension: "COMMERCIAL",
      isPrimary: true,
      assignmentSource,
    }));
    const res = await this.prisma.productCategoryMap.createMany({ data, skipDuplicates: true });
    return res.count;
  }

  /**
   * Tier 1 of the commercial-classification design: deterministic generic-name/dosage-form
   * keyword rules (see `deterministic-medicine-classifier.ts`). Only reclassifies products
   * whose primary COMMERCIAL category is still the "Unclassified Medicines" safety net with
   * `assignmentSource: SYSTEM_DEFAULT` — a MANUAL or previously AUTO_CLASSIFIED assignment is
   * never touched. Anything the rules can't confidently place stays in Unclassified Medicines
   * for human review, rather than guessing. Batched by target category, not per-product, so it
   * stays cheap against a full NMRA-sized catalog.
   *
   * `productIds` narrows the sweep to one import's own products. Without it every call
   * re-scans the tenant's whole Unclassified pile, which on a registry-sized catalog means a
   * product-list import of twenty rows drags several thousand reference rows through the
   * classifier for nothing.
   */
  async applyDeterministicMedicineClassification(
    tenantId: string,
    productIds?: readonly string[],
  ): Promise<{
    reclassified: number;
    stillUnclassified: number;
  }> {
    if (productIds && productIds.length === 0) {
      return { reclassified: 0, stillUnclassified: 0 };
    }
    const unclassified = await this.prisma.productCategory.findFirst({
      where: { tenantId, dimension: "COMMERCIAL", canonicalKey: UNCLASSIFIED_MEDICINES_CANONICAL_KEY },
      select: { id: true },
    });
    if (!unclassified) return { reclassified: 0, stillUnclassified: 0 };

    const candidates = await this.prisma.productCategoryMap.findMany({
      where: {
        tenantId,
        dimension: "COMMERCIAL",
        isPrimary: true,
        categoryId: unclassified.id,
        assignmentSource: "SYSTEM_DEFAULT",
        ...(productIds ? { productId: { in: [...productIds] } } : {}),
      },
      select: {
        productId: true,
        product: {
          select: { genericName: true, name: true, dosageForm: true, brandName: true },
        },
      },
    });

    // Grouped by (canonicalKey, confidence) — the classifier only ever returns a handful of
    // distinct confidence values, so this keeps inserts to a few `createMany` batches instead
    // of one round-trip per product.
    const byGroupKey = new Map<
      string,
      { canonicalKey: string; confidence: number; productIds: string[] }
    >();
    let stillUnclassified = 0;
    for (const row of candidates) {
      const result = classifyMedicine(
        row.product.genericName,
        row.product.name,
        row.product.dosageForm,
        row.product.brandName,
      );
      if (!result) {
        stillUnclassified += 1;
        continue;
      }
      const key = `${result.canonicalKey} ${result.confidence}`;
      const entry = byGroupKey.get(key) ?? {
        canonicalKey: result.canonicalKey,
        confidence: result.confidence,
        productIds: [],
      };
      entry.productIds.push(row.productId);
      byGroupKey.set(key, entry);
    }

    const canonicalIds = await this.commercialCanonicalIds(tenantId);
    let reclassified = 0;
    for (const { canonicalKey, confidence, productIds } of byGroupKey.values()) {
      const categoryId = canonicalIds.get(canonicalKey);
      if (!categoryId) continue; // template not seeded for this key — leave in Unclassified

      for (const group of chunk(productIds, 400)) {
        await this.prisma.productCategoryMap.deleteMany({
          where: { tenantId, productId: { in: group }, dimension: "COMMERCIAL", isPrimary: true },
        });
        await this.prisma.productCategoryMap.createMany({
          data: group.map((productId) => ({
            tenantId,
            productId,
            categoryId,
            dimension: "COMMERCIAL" as const,
            isPrimary: true,
            assignmentSource: "AUTO_CLASSIFIED" as const,
            confidence,
          })),
        });
        reclassified += group.length;
      }
    }

    return { reclassified, stillUnclassified };
  }
}
