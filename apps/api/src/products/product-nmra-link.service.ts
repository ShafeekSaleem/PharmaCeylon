import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { RegulatoryDimension } from "../catalog/category-taxonomy.service";
import { CategoryTaxonomyService } from "../catalog/category-taxonomy.service";
import { UNCLASSIFIED_MEDICINES_CANONICAL_KEY } from "../catalog/commercial-category-template";
import {
  CatalogIndex,
  rankedCandidateNeedsComplianceConfirmation,
  type ImportRowKeys,
  type RankedCandidate,
} from "../product-import/product-import-match";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { ReferenceCandidateFinder } from "./reference-candidates";
import {
  buildNmraLinkPlan,
  type NmraLinkAlias,
  type NmraLinkableFields,
  type NmraLinkPlan,
} from "./product-nmra-link.util";

const REGULATORY_DIMENSIONS: RegulatoryDimension[] = [
  "DOSAGE_FORM",
  "NMRA_SCHEDULE",
  "REGISTRATION_TYPE",
];

const LINKABLE_SELECT = {
  id: true,
  tenantId: true,
  name: true,
  brandName: true,
  barcode: true,
  genericName: true,
  dosageForm: true,
  strength: true,
  unit: true,
  packSize: true,
  packType: true,
  manufacturer: true,
  localAgent: true,
  countryOfOrigin: true,
  storage: true,
  shelfLife: true,
  registrationNo: true,
  registrationDate: true,
  schedule: true,
  regType: true,
  dossierNo: true,
  isControlled: true,
  requiresPrescription: true,
  rangeStatus: true,
  source: true,
  nmraReferenceId: true,
} as const;

type LinkableRow = {
  id: string;
  tenantId: string;
  name: string;
  brandName: string | null;
  barcode: string | null;
  genericName: string | null;
  dosageForm: string | null;
  strength: string | null;
  unit: string | null;
  packSize: string | null;
  packType: string | null;
  manufacturer: string | null;
  localAgent: string | null;
  countryOfOrigin: string | null;
  storage: string | null;
  shelfLife: string | null;
  registrationNo: string | null;
  registrationDate: Date | null;
  schedule: string | null;
  regType: string | null;
  dossierNo: string | null;
  isControlled: boolean;
  requiresPrescription: boolean;
  rangeStatus: string;
  source: string;
  nmraReferenceId: string | null;
};

function toLinkable(row: LinkableRow): NmraLinkableFields {
  return {
    name: row.name,
    brandName: row.brandName,
    barcode: row.barcode,
    genericName: row.genericName,
    dosageForm: row.dosageForm,
    strength: row.strength,
    unit: row.unit,
    packSize: row.packSize,
    packType: row.packType,
    manufacturer: row.manufacturer,
    localAgent: row.localAgent,
    countryOfOrigin: row.countryOfOrigin,
    storage: row.storage,
    shelfLife: row.shelfLife,
    registrationNo: row.registrationNo,
    registrationDate: row.registrationDate,
    schedule: row.schedule,
    regType: row.regType,
    dossierNo: row.dossierNo,
    isControlled: row.isControlled,
    requiresPrescription: row.requiresPrescription,
  };
}

/** What `link()`/`unlink()` restore on undo — every value the link overwrote or added. */
type NmraLinkSnapshot = {
  scalars: NmraLinkableFields;
  aliasesAdded: NmraLinkAlias[];
  regulatoryBefore: Array<{ dimension: RegulatoryDimension; categoryId: string }>;
  commercialCategoryIdBefore: string | null;
  commercialCategoryAdopted: boolean;
  tagIdsAdded: string[];
};

export type NmraLinkCandidate = {
  product: {
    id: string;
    name: string;
    brandName: string | null;
    genericName: string | null;
    strength: string | null;
    dosageForm: string | null;
    registrationNo: string | null;
    isControlled: boolean;
    requiresPrescription: boolean;
  };
  evidence: RankedCandidate["evidence"];
  needsComplianceConfirmation: boolean;
};

/** The shop product row shown in the bulk review queue — just enough to identify it in a list. */
export type LinkableSummary = { id: string; name: string; brandName: string | null };

/** The keys `CatalogIndex.rankedCandidates` reads off a linkable row. */
function searchKeysOf(row: {
  name: string;
  barcode: string | null;
  registrationNo: string | null;
  genericName: string | null;
  strength: string | null;
  dosageForm: string | null;
}) {
  return {
    name: row.name,
    barcode: row.barcode,
    registrationNo: row.registrationNo,
    genericName: row.genericName,
    strength: row.strength,
    dosageForm: row.dosageForm,
  };
}

export type NmraLinkPreview = {
  plan: NmraLinkPlan;
  regulatoryCategories: Array<{ dimension: RegulatoryDimension; categoryId: string; categoryName: string }>;
  commercialCategory: { willAdopt: boolean; categoryId: string | null; categoryName: string | null } | null;
  tagsToMerge: Array<{ id: string; name: string }>;
  reference: { id: string; name: string; brandName: string | null; registrationNo: string | null };
};

/**
 * Links a shop's own product to an NMRA reference row: a matcher that surfaces ranked
 * candidates for a human to choose from (see `rankedCandidates` in product-import-match.ts),
 * a field-by-field preview built from `buildNmraLinkPlan`, and an apply/unlink pair where
 * unlink restores exactly what linking changed. See "Field ownership when a product is
 * linked" in the catalog-organisation plan for the policy this implements.
 */
@Injectable()
export class ProductNmraLinkService {
  private readonly finder: ReferenceCandidateFinder;

  constructor(
    private readonly prisma: PrismaService,
    private readonly taxonomy: CategoryTaxonomyService,
    private readonly audit: AuditService,
  ) {
    this.finder = new ReferenceCandidateFinder(prisma);
  }

  /** Ranked candidates for linking one product, strongest evidence first. */
  async candidates(tenantId: string, productId: string, take = 20): Promise<NmraLinkCandidate[]> {
    const shop = await this.loadLinkable(tenantId, productId);
    const index = await this.buildReferenceIndex(tenantId, productId, [searchKeysOf(shop)]);
    const ranked = index.rankedCandidates(searchKeysOf(shop), take);
    return ranked.map((r) => this.toLinkCandidate(r));
  }

  /**
   * A page of the "find register matches" review queue: the shop's own unlinked products,
   * each with its top candidates — the same confidence-grouped shape the import wizard's
   * review step uses, so accepting a whole tier at once feels the same in both places.
   *
   * Builds the reference-row index once and reuses it across the whole page, rather than
   * once per product — the index scan is the expensive part, and a page is the unit an
   * operator actually acts on.
   */
  async unlinkedQueue(
    tenantId: string,
    skip = 0,
    take = 50,
  ): Promise<{ items: Array<{ product: LinkableSummary; candidates: NmraLinkCandidate[] }>; total: number }> {
    const where = {
      tenantId,
      rangeStatus: "RANGED" as const,
      source: { not: "NMRA" as const },
      nmraReferenceId: null,
    };
    const [rows, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        select: LINKABLE_SELECT,
        orderBy: { name: "asc" },
        skip: Math.max(0, skip),
        take: Math.min(Math.max(1, take), 200),
      }),
      this.prisma.product.count({ where }),
    ]);

    const index = await this.buildReferenceIndex(tenantId, null, rows.map(searchKeysOf));
    const items = rows.map((row) => ({
      product: { id: row.id, name: row.name, brandName: row.brandName },
      candidates: index.rankedCandidates(searchKeysOf(row), 5).map((r) => this.toLinkCandidate(r)),
    }));

    return { items, total };
  }

  /**
   * Applies many links in one call — the bulk-accept action over the review queue. Each pair
   * is re-checked against the current candidate evidence rather than trusted as given: a
   * pair whose evidence would need individual confirmation (see
   * `rankedCandidateNeedsComplianceConfirmation`) is held out, not silently applied, matching
   * the rule the single-product flow already enforces.
   */
  async bulkLink(
    tenantId: string,
    userId: string,
    pairs: Array<{ productId: string; referenceProductId: string }>,
  ): Promise<{
    linked: string[];
    held: Array<{ productId: string; reason: string }>;
    failed: Array<{ productId: string; reason: string }>;
  }> {
    const linked: string[] = [];
    const held: Array<{ productId: string; reason: string }> = [];
    const failed: Array<{ productId: string; reason: string }> = [];

    // Built once and reused across the whole batch. A reference row claimed by an earlier
    // pair in this same batch still looks available here — `link()` re-checks fresh before
    // writing, so a same-batch double-claim still can't happen, it just surfaces as `failed`
    // (a real conflict) rather than `held` (a soft skip) for that rare case.
    const shopRows = await this.prisma.product.findMany({
      where: { tenantId, id: { in: pairs.map((p) => p.productId) } },
      select: LINKABLE_SELECT,
    });
    const index = await this.buildReferenceIndex(tenantId, null, shopRows.map(searchKeysOf));

    for (const pair of pairs) {
      try {
        const shop = await this.loadLinkable(tenantId, pair.productId);
        if (shop.nmraReferenceId) {
          held.push({ productId: pair.productId, reason: "Already linked to a register entry." });
          continue;
        }
        const ranked = index.rankedCandidates(searchKeysOf(shop), 20);
        const match = ranked.find((r) => r.candidate.id === pair.referenceProductId);
        if (!match) {
          held.push({
            productId: pair.productId,
            reason: "That register entry is no longer offered as a candidate for this product.",
          });
          continue;
        }
        if (rankedCandidateNeedsComplianceConfirmation(match)) {
          held.push({
            productId: pair.productId,
            reason: "Would change a compliance flag on evidence weaker than an exact identifier — needs individual confirmation.",
          });
          continue;
        }
        // Only the unattended path checks this. A person choosing one entry from a list has
        // already resolved the ambiguity by hand — it is the batch that must not guess.
        try {
          await this.assertIdentifiersUnambiguous(tenantId, shop);
        } catch (err) {
          held.push({
            productId: pair.productId,
            reason: err instanceof Error ? err.message : "Identifier is ambiguous.",
          });
          continue;
        }
        await this.link(tenantId, userId, pair.productId, pair.referenceProductId);
        linked.push(pair.productId);
      } catch (err) {
        failed.push({
          productId: pair.productId,
          reason: err instanceof Error ? err.message : "Link failed.",
        });
      }
    }

    return { linked, held, failed };
  }

  /** The field-by-field diff a link would make, without writing anything. */
  async preview(
    tenantId: string,
    productId: string,
    referenceProductId: string,
    opts?: { adoptFieldOverrides?: string[] },
  ): Promise<NmraLinkPreview> {
    const shop = await this.loadLinkable(tenantId, productId);
    const reference = await this.loadReferenceCandidate(tenantId, referenceProductId, productId);
    const plan = buildNmraLinkPlan(toLinkable(shop), toLinkable(reference), opts);

    const [referenceRegulatory, referenceCommercial, referenceTags, shopCommercial, shopTagIds] =
      await Promise.all([
        this.prisma.productCategoryMap.findMany({
          where: { tenantId, productId: reference.id, dimension: { in: REGULATORY_DIMENSIONS } },
          select: { dimension: true, categoryId: true, category: { select: { name: true } } },
        }),
        this.prisma.productCategoryMap.findFirst({
          where: { tenantId, productId: reference.id, dimension: "COMMERCIAL", isPrimary: true },
          select: { categoryId: true, category: { select: { name: true, canonicalKey: true } } },
        }),
        this.prisma.productTagMap.findMany({
          where: { tenantId, productId: reference.id },
          select: { tagId: true, tag: { select: { id: true, name: true } } },
        }),
        this.prisma.productCategoryMap.findFirst({
          where: { tenantId, productId: shop.id, dimension: "COMMERCIAL", isPrimary: true },
          select: { categoryId: true, category: { select: { canonicalKey: true } } },
        }),
        this.prisma.productTagMap.findMany({
          where: { tenantId, productId: shop.id },
          select: { tagId: true },
        }),
      ]);

    const shopTagIdSet = new Set(shopTagIds.map((t) => t.tagId));
    const willAdoptCommercial =
      !shopCommercial || shopCommercial.category.canonicalKey === UNCLASSIFIED_MEDICINES_CANONICAL_KEY;

    return {
      plan,
      regulatoryCategories: referenceRegulatory.map((m) => ({
        dimension: m.dimension as RegulatoryDimension,
        categoryId: m.categoryId,
        categoryName: m.category.name,
      })),
      commercialCategory: referenceCommercial
        ? {
            willAdopt: willAdoptCommercial,
            categoryId: referenceCommercial.categoryId,
            categoryName: referenceCommercial.category.name,
          }
        : null,
      tagsToMerge: referenceTags
        .filter((t) => !shopTagIdSet.has(t.tagId))
        .map((t) => ({ id: t.tag.id, name: t.tag.name })),
      reference: {
        id: reference.id,
        name: reference.name,
        brandName: reference.brandName,
        registrationNo: reference.registrationNo,
      },
    };
  }

  /** Applies the link: writes the field plan, absorbs categories/tags, records the undo snapshot. */
  async link(
    tenantId: string,
    userId: string,
    productId: string,
    referenceProductId: string,
    opts?: { adoptFieldOverrides?: string[] },
  ) {
    const shop = await this.loadLinkable(tenantId, productId);
    if (shop.nmraReferenceId) {
      throw new ConflictException(
        "This product is already linked to a register entry — unlink it first.",
      );
    }
    const reference = await this.loadReferenceCandidate(tenantId, referenceProductId, productId);

    const plan = buildNmraLinkPlan(toLinkable(shop), toLinkable(reference), opts);

    const [shopRegulatoryBefore, shopCommercialBefore, referenceRegulatory, referenceCommercial, referenceTags, shopTagIds] =
      await Promise.all([
        this.prisma.productCategoryMap.findMany({
          where: { tenantId, productId: shop.id, dimension: { in: REGULATORY_DIMENSIONS } },
          select: { dimension: true, categoryId: true },
        }),
        this.prisma.productCategoryMap.findFirst({
          where: { tenantId, productId: shop.id, dimension: "COMMERCIAL", isPrimary: true },
          select: { categoryId: true, category: { select: { canonicalKey: true } } },
        }),
        this.prisma.productCategoryMap.findMany({
          where: { tenantId, productId: reference.id, dimension: { in: REGULATORY_DIMENSIONS } },
          select: { dimension: true, categoryId: true },
        }),
        this.prisma.productCategoryMap.findFirst({
          where: { tenantId, productId: reference.id, dimension: "COMMERCIAL", isPrimary: true },
          select: { categoryId: true },
        }),
        this.prisma.productTagMap.findMany({
          where: { tenantId, productId: reference.id },
          select: { tagId: true },
        }),
        this.prisma.productTagMap.findMany({
          where: { tenantId, productId: shop.id },
          select: { tagId: true },
        }),
      ]);

    const shopTagIdSet = new Set(shopTagIds.map((t) => t.tagId));
    const tagIdsToAdd = referenceTags.map((t) => t.tagId).filter((id) => !shopTagIdSet.has(id));
    const willAdoptCommercial =
      !shopCommercialBefore ||
      shopCommercialBefore.category.canonicalKey === UNCLASSIFIED_MEDICINES_CANONICAL_KEY;

    const snapshot: NmraLinkSnapshot = {
      scalars: toLinkable(shop),
      aliasesAdded: plan.aliasesToAdd,
      regulatoryBefore: shopRegulatoryBefore.map((m) => ({
        dimension: m.dimension as RegulatoryDimension,
        categoryId: m.categoryId,
      })),
      commercialCategoryIdBefore: shopCommercialBefore?.categoryId ?? null,
      commercialCategoryAdopted: willAdoptCommercial && Boolean(referenceCommercial),
      tagIdsAdded: tagIdsToAdd,
    };

    await this.prisma.$transaction(async (tx) => {
      await tx.product.update({
        where: { id: shop.id, tenantId },
        data: { ...toPrismaUpdate(plan.updates), nmraReferenceId: reference.id },
      });

      for (const alias of plan.aliasesToAdd) {
        await tx.productAlias.upsert({
          where: {
            tenantId_productId_aliasText: {
              tenantId,
              productId: shop.id,
              aliasText: alias.aliasText,
            },
          },
          create: { tenantId, productId: shop.id, aliasText: alias.aliasText, aliasType: alias.aliasType },
          update: { aliasType: alias.aliasType },
        });
      }

      if (referenceRegulatory.length > 0) {
        await tx.productCategoryMap.deleteMany({
          where: { tenantId, productId: shop.id, dimension: { in: REGULATORY_DIMENSIONS } },
        });
        await tx.productCategoryMap.createMany({
          data: referenceRegulatory.map((m) => ({
            tenantId,
            productId: shop.id,
            categoryId: m.categoryId,
            dimension: m.dimension,
            isPrimary: true,
            assignmentSource: "NMRA_LINK" as const,
          })),
          skipDuplicates: true,
        });
      }

      if (tagIdsToAdd.length > 0) {
        await tx.productTagMap.createMany({
          data: tagIdsToAdd.map((tagId) => ({ tenantId, productId: shop.id, tagId })),
          skipDuplicates: true,
        });
      }

      await tx.productNmraLink.create({
        data: {
          tenantId,
          productId: shop.id,
          referenceProductId: reference.id,
          adoptedFields: plan.changes.filter((c) => c.changed).map((c) => c.field),
          previousValues: snapshot as object,
          linkedByUserId: userId,
        },
      });
    });

    // Outside the transaction above, matching how the NMRA importer itself applies commercial
    // classification: `setPrimaryCommercialCategory` runs its own small transaction and is
    // idempotent, so composing it with the main write only costs a (rare) window where a link
    // is recorded a moment before its commercial category lands, not a correctness problem.
    if (willAdoptCommercial && referenceCommercial) {
      await this.taxonomy.setPrimaryCommercialCategory(
        tenantId,
        shop.id,
        referenceCommercial.categoryId,
        { assignmentSource: "NMRA_LINK" },
      );
    }

    await this.audit.log({
      tenantId,
      actorUserId: userId,
      eventName: "products.nmra_link",
      entityName: "product",
      entityId: shop.id,
      payload: {
        referenceProductId: reference.id,
        referenceName: reference.name,
        registrationNo: reference.registrationNo,
        fieldsChanged: plan.changes.filter((c) => c.changed).map((c) => c.field),
        complianceStatements: plan.complianceStatements,
      },
    });

    return this.prisma.product.findFirst({ where: { id: shop.id, tenantId } });
  }

  /** Restores every value the link changed or added, then removes the link. */
  async unlink(tenantId: string, userId: string, productId: string) {
    const link = await this.prisma.productNmraLink.findFirst({
      where: { tenantId, productId },
    });
    if (!link) {
      throw new NotFoundException("This product isn't linked to a register entry.");
    }
    const snapshot = link.previousValues as unknown as NmraLinkSnapshot;

    // Never leave a product without a primary commercial category (Section 03's "Unclassified
    // is the floor, never nothing") — if it had none before, restore to Unclassified rather
    // than to nothing.
    let restoreCommercialTo = snapshot.commercialCategoryIdBefore;
    if (snapshot.commercialCategoryAdopted && !restoreCommercialTo) {
      const canonicalIds = await this.taxonomy.commercialCanonicalIds(tenantId);
      restoreCommercialTo = canonicalIds.get(UNCLASSIFIED_MEDICINES_CANONICAL_KEY) ?? null;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.product.update({
        where: { id: productId, tenantId },
        data: { ...toPrismaUpdate(snapshot.scalars), nmraReferenceId: null },
      });

      for (const alias of snapshot.aliasesAdded) {
        await tx.productAlias.deleteMany({
          where: { tenantId, productId, aliasText: alias.aliasText, aliasType: alias.aliasType },
        });
      }

      if (snapshot.commercialCategoryAdopted) {
        await tx.productCategoryMap.deleteMany({
          where: { tenantId, productId, dimension: "DOSAGE_FORM" },
        });
        await tx.productCategoryMap.deleteMany({
          where: { tenantId, productId, dimension: "NMRA_SCHEDULE" },
        });
        await tx.productCategoryMap.deleteMany({
          where: { tenantId, productId, dimension: "REGISTRATION_TYPE" },
        });
      } else {
        await tx.productCategoryMap.deleteMany({
          where: { tenantId, productId, dimension: { in: REGULATORY_DIMENSIONS } },
        });
      }
      if (snapshot.regulatoryBefore.length > 0) {
        await tx.productCategoryMap.createMany({
          data: snapshot.regulatoryBefore.map((m) => ({
            tenantId,
            productId,
            categoryId: m.categoryId,
            dimension: m.dimension,
            isPrimary: true,
            assignmentSource: "NMRA_IMPORT" as const,
          })),
          skipDuplicates: true,
        });
      }

      if (restoreCommercialTo) {
        await tx.productCategoryMap.upsert({
          where: {
            tenantId_productId_categoryId: {
              tenantId,
              productId,
              categoryId: restoreCommercialTo,
            },
          },
          create: {
            tenantId,
            productId,
            categoryId: restoreCommercialTo,
            dimension: "COMMERCIAL",
            isPrimary: true,
            assignmentSource: "SYSTEM_DEFAULT",
          },
          update: { isPrimary: true },
        });
      }

      if (snapshot.tagIdsAdded.length > 0) {
        await tx.productTagMap.deleteMany({
          where: { tenantId, productId, tagId: { in: snapshot.tagIdsAdded } },
        });
      }

      await tx.productNmraLink.delete({ where: { id: link.id, tenantId } });
    });

    await this.audit.log({
      tenantId,
      actorUserId: userId,
      eventName: "products.nmra_unlink",
      entityName: "product",
      entityId: productId,
      payload: { referenceProductId: link.referenceProductId },
    });

    return this.prisma.product.findFirst({ where: { id: productId, tenantId } });
  }

  private async loadLinkable(tenantId: string, productId: string): Promise<LinkableRow> {
    const row = await this.prisma.product.findFirst({
      where: { id: productId, tenantId },
      select: LINKABLE_SELECT,
    });
    if (!row) throw new NotFoundException("Product not found");
    return row;
  }

  private async loadReferenceCandidate(
    tenantId: string,
    referenceProductId: string,
    excludeProductId: string,
  ): Promise<LinkableRow> {
    if (referenceProductId === excludeProductId) {
      throw new BadRequestException("A product can't be linked to itself.");
    }
    const row = await this.prisma.product.findFirst({
      where: { id: referenceProductId, tenantId },
      select: LINKABLE_SELECT,
    });
    if (!row) throw new NotFoundException("Reference product not found");
    if (row.rangeStatus !== "REFERENCE" || row.source !== "NMRA") {
      throw new BadRequestException(
        "Only an NMRA reference-catalog row can be linked to — this is one of the shop's own products.",
      );
    }
    const claim = await this.prisma.product.findFirst({
      where: { tenantId, nmraReferenceId: referenceProductId },
      select: { id: true },
    });
    if (claim) {
      throw new ConflictException("This register entry is already linked to another product.");
    }
    return row;
  }

  /**
   * An index over the reference rows worth comparing `rows` against.
   *
   * This used to be `findMany({ ..., take: 5000 })` — the whole reference catalog, truncated.
   * On the 15,000-row NMRA register that silently made two thirds of it unmatchable, and which
   * two thirds depended on Postgres' row order. `ReferenceCandidateFinder` asks the database
   * narrow, indexed questions driven by the products being matched instead, so every register
   * row is reachable and the data pulled scales with the page, not the catalog.
   */
  private async buildReferenceIndex(
    tenantId: string,
    excludeProductId: string | null,
    rows: ImportRowKeys[],
  ): Promise<CatalogIndex> {
    const set = await this.finder.forMany(tenantId, rows, { excludeProductId });
    return new CatalogIndex(set.candidates);
  }

  /**
   * Refuses to guess when an identifier is ambiguous.
   *
   * A duplicate barcode or registration number in the register means the identifier does not
   * identify anything, and picking the first row Postgres returned would set compliance flags
   * from an arbitrary product. Callers surface this as a review task instead.
   */
  private async assertIdentifiersUnambiguous(tenantId: string, shop: LinkableRow): Promise<void> {
    const probes: Array<["barcode" | "registrationNo", string | null]> = [
      ["barcode", shop.barcode],
      ["registrationNo", shop.registrationNo],
    ];
    for (const [field, value] of probes) {
      if (!value?.trim()) continue;
      const ambiguity = await this.finder.resolveIdentifier(tenantId, field, value);
      if (!ambiguity) continue;
      const label = field === "barcode" ? "barcode" : "registration number";
      throw new ConflictException(
        `The ${label} "${ambiguity.value}" matches ${ambiguity.candidates.length} register entries ` +
          `(${ambiguity.candidates.map((c) => c.name).slice(0, 3).join(", ")}…). ` +
          "Pick the right one explicitly — it can't be resolved automatically.",
      );
    }
  }

  private toLinkCandidate(ranked: RankedCandidate): NmraLinkCandidate {
    return {
      product: {
        id: ranked.candidate.id,
        name: ranked.candidate.name,
        brandName: ranked.candidate.brandName,
        genericName: ranked.candidate.genericName,
        strength: ranked.candidate.strength,
        dosageForm: ranked.candidate.dosageForm,
        registrationNo: ranked.candidate.registrationNo,
        isControlled: ranked.candidate.isControlled,
        requiresPrescription: ranked.candidate.requiresPrescription,
      },
      evidence: ranked.evidence,
      needsComplianceConfirmation: rankedCandidateNeedsComplianceConfirmation(ranked),
    };
  }
}

/** `NmraLinkableFields` values as a Prisma `product.update` data object. */
function toPrismaUpdate(fields: Partial<NmraLinkableFields>): Record<string, unknown> {
  return { ...fields };
}
