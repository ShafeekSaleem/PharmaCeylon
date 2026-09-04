import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CategoryTaxonomyService } from "../catalog/category-taxonomy.service";
import { UNCLASSIFIED_MEDICINES_CANONICAL_KEY } from "../catalog/commercial-category-template";
import { classifyMedicine } from "../catalog/deterministic-medicine-classifier";

/** How many unplaced products one page of the worklist returns. */
const DEFAULT_TAKE = 50;
const MAX_TAKE = 200;

export type OrganizeCoverage = {
  /** Products the pharmacy sells. */
  ranged: number;
  /** Of those, the ones filed somewhere real. */
  categorized: number;
  /** Of those, the ones still in Unclassified or with no category at all. */
  unplaced: number;
  /** 0–100. A shop with nothing ranged yet is 100, not 0 — there is nothing to place. */
  percent: number;
};

export type UnplacedProduct = {
  id: string;
  name: string;
  sku: string;
  brandName: string | null;
  genericName: string | null;
  dosageForm: string | null;
  strength: string | null;
  suggestion: {
    categoryId: string;
    categoryName: string;
    categoryPath: string;
    confidence: number;
  } | null;
};

/**
 * The "organize your catalog" worklist.
 *
 * A quarter of a real pharmacy's range sits in Unclassified Medicines and nothing surfaces it:
 * no coverage figure, no queue, discoverable only by filtering for the category by hand. This
 * turns that into a finishable job — a number that goes up, and a list where each row arrives
 * with a suggestion so the pharmacist confirms rather than decides.
 */
@Injectable()
export class ProductOrganizeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly taxonomy: CategoryTaxonomyService,
  ) {}

  async coverage(tenantId: string): Promise<OrganizeCoverage> {
    const unclassifiedId = await this.unclassifiedId(tenantId);
    const [ranged, unplaced] = await Promise.all([
      this.prisma.product.count({ where: { tenantId, rangeStatus: "RANGED" } }),
      this.prisma.product.count({ where: this.unplacedWhere(tenantId, unclassifiedId) }),
    ]);
    const categorized = Math.max(0, ranged - unplaced);
    return {
      ranged,
      categorized,
      unplaced,
      percent: ranged === 0 ? 100 : Math.round((categorized / ranged) * 100),
    };
  }

  async unplaced(
    tenantId: string,
    skip = 0,
    take = DEFAULT_TAKE,
  ): Promise<{ items: UnplacedProduct[]; total: number }> {
    const unclassifiedId = await this.unclassifiedId(tenantId);
    const where = this.unplacedWhere(tenantId, unclassifiedId);
    const [rows, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        orderBy: { name: "asc" },
        skip: Math.max(0, skip),
        take: Math.min(Math.max(1, take), MAX_TAKE),
        select: {
          id: true,
          name: true,
          sku: true,
          brandName: true,
          genericName: true,
          dosageForm: true,
          strength: true,
        },
      }),
      this.prisma.product.count({ where }),
    ]);

    // One lookup for the whole page — the classifier speaks canonicalKey, the UI needs ids.
    const canonicalIds = await this.taxonomy.commercialCanonicalIds(tenantId);
    const categories = await this.prisma.productCategory.findMany({
      where: { tenantId, dimension: "COMMERCIAL" },
      select: { id: true, name: true, parentCategoryId: true },
    });
    const nameById = new Map(categories.map((c) => [c.id, c.name]));
    const parentById = new Map(categories.map((c) => [c.id, c.parentCategoryId]));

    const items = rows.map((row): UnplacedProduct => {
      const hit = classifyMedicine(row.genericName, row.name, row.dosageForm, row.brandName);
      const categoryId = hit ? canonicalIds.get(hit.canonicalKey) : undefined;
      if (!hit || !categoryId) return { ...row, suggestion: null };

      const name = nameById.get(categoryId) ?? "";
      const parentId = parentById.get(categoryId);
      const parentName = parentId ? nameById.get(parentId) : undefined;
      return {
        ...row,
        suggestion: {
          categoryId,
          categoryName: name,
          categoryPath: parentName ? `${parentName} › ${name}` : name,
          confidence: hit.confidence,
        },
      };
    });

    return { items, total };
  }

  /**
   * A product needs placing when it has no primary commercial category at all, or when the one
   * it has is the Unclassified safety net. Reference rows are excluded — the registry is not
   * the pharmacy's merchandising problem.
   */
  private unplacedWhere(tenantId: string, unclassifiedId: string | null) {
    const noCategory = {
      categoryMaps: { none: { dimension: "COMMERCIAL" as const, isPrimary: true } },
    };
    return {
      tenantId,
      rangeStatus: "RANGED" as const,
      ...(unclassifiedId
        ? {
            OR: [
              noCategory,
              {
                categoryMaps: {
                  some: {
                    dimension: "COMMERCIAL" as const,
                    isPrimary: true,
                    categoryId: unclassifiedId,
                  },
                },
              },
            ],
          }
        : noCategory),
    };
  }

  private async unclassifiedId(tenantId: string): Promise<string | null> {
    const row = await this.prisma.productCategory.findFirst({
      where: {
        tenantId,
        dimension: "COMMERCIAL",
        canonicalKey: UNCLASSIFIED_MEDICINES_CANONICAL_KEY,
      },
      select: { id: true },
    });
    return row?.id ?? null;
  }
}
