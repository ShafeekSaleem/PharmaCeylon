import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { CatalogTaskStatus, CatalogTaskType } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { CategoryTaxonomyService } from "../catalog/category-taxonomy.service";
import { UNCLASSIFIED_MEDICINES_CANONICAL_KEY } from "../catalog/commercial-category-template";
import { classifyMedicine } from "../catalog/deterministic-medicine-classifier";
import { classifyNmraEligibility } from "../catalog/nmra-eligibility";
import { PrismaService } from "../prisma/prisma.service";
import {
  CatalogIndex,
  type MatchCandidate,
} from "../product-import/product-import-match";
import { ProductNmraLinkService } from "../products/product-nmra-link.service";
import { ReferenceCandidateFinder } from "../products/reference-candidates";
import { classifyTaskSafety } from "./catalog-task-safety";
import {
  evidenceLabel,
  OPEN_STATUSES,
  type CatalogTaskFacetCounts,
  type CatalogTaskFilter,
  type CatalogTaskListResult,
  type CatalogTaskSummary,
  type CatalogTaskView,
} from "./catalog-task.types";

/** How many products one `refresh` pass examines per batch. */
const REFRESH_BATCH = 200;
/** Ceiling on a single refresh, so a first run against a 20,000-product tenant stays bounded. */
const REFRESH_MAX_PRODUCTS = 5000;
const DEFAULT_TAKE = 50;
const MAX_TAKE = 200;

/** What "ambiguous" means everywhere: more than one plausible answer for one identifier. */
const AMBIGUOUS_TYPES: CatalogTaskType[] = ["NMRA_AMBIGUOUS", "IMPORT_DUPLICATE"];

type ProductRow = {
  id: string;
  name: string;
  sku: string;
  brandName: string | null;
  genericName: string | null;
  dosageForm: string | null;
  strength: string | null;
  barcode: string | null;
  registrationNo: string | null;
  schedule: string | null;
  regType: string | null;
  source: string;
  importId: string | null;
  isControlled: boolean;
  requiresPrescription: boolean;
  nmraReferenceId: string | null;
};

const PRODUCT_SELECT = {
  id: true,
  name: true,
  sku: true,
  brandName: true,
  genericName: true,
  dosageForm: true,
  strength: true,
  barcode: true,
  registrationNo: true,
  schedule: true,
  regType: true,
  source: true,
  importId: true,
  isControlled: true,
  requiresPrescription: true,
  nmraReferenceId: true,
} as const;

/** A task row about to be written, before it is split into creates and updates. */
type PendingTask = {
  productId: string;
  type: CatalogTaskType;
  status: CatalogTaskStatus;
  suggestion: Prisma.InputJsonValue | null;
  evidence: string | null;
  confidence: number | null;
  complianceImpact: boolean;
  safeToApply: boolean;
  candidates: Prisma.InputJsonValue | null;
  importId: string | null;
  resolutionNote: string | null;
};

/**
 * The catalog Work Queue: every catalog decision waiting on a person, in one durable list.
 *
 * Replaces two screens that each recomputed their own list on every load — Organize (missing
 * categories) and Register matches (NMRA links). Because neither persisted anything, neither
 * could accept an answer: "this umbrella is not a medicine" survived exactly until the next
 * page load. Tasks here have a lifecycle, so a decision is a decision.
 *
 * `refresh` is idempotent and never overwrites a terminal row, which is what makes it safe to
 * run after every import, on demand from the UI, and (eventually) on a schedule.
 */
@Injectable()
export class CatalogTaskService {
  private readonly logger = new Logger(CatalogTaskService.name);
  private readonly finder: ReferenceCandidateFinder;

  constructor(
    private readonly prisma: PrismaService,
    private readonly taxonomy: CategoryTaxonomyService,
    private readonly nmraLink: ProductNmraLinkService,
    private readonly audit: AuditService,
  ) {
    this.finder = new ReferenceCandidateFinder(prisma);
  }

  // ───────────────────────────── generation ─────────────────────────────

  /**
   * Recompute outstanding catalog work for a tenant.
   *
   * `importId` scopes the pass to one import's products and stamps the tasks it creates with
   * it, which is what makes "review the tasks this upload created" a real link rather than a
   * guess. Without it, the whole range is examined.
   */
  async refresh(
    tenantId: string,
    opts: { importId?: string; productIds?: string[] } = {},
  ): Promise<{ created: number; updated: number; closed: number }> {
    const scope: Prisma.ProductWhereInput = {
      tenantId,
      rangeStatus: "RANGED",
      ...(opts.importId ? { importId: opts.importId } : {}),
      ...(opts.productIds?.length ? { id: { in: opts.productIds } } : {}),
    };

    const totals = { created: 0, updated: 0, closed: 0 };

    const categoryOutcome = await this.refreshCategoryTasks(
      tenantId,
      scope,
      opts.importId,
    );
    const nmraOutcome = await this.refreshNmraTasks(
      tenantId,
      scope,
      opts.importId,
    );
    for (const outcome of [categoryOutcome, nmraOutcome]) {
      totals.created += outcome.created;
      totals.updated += outcome.updated;
      totals.closed += outcome.closed;
    }
    return totals;
  }

  /** MISSING_CATEGORY: products with no primary commercial category, or parked in Unclassified. */
  private async refreshCategoryTasks(
    tenantId: string,
    scope: Prisma.ProductWhereInput,
    importId?: string,
  ) {
    const unclassifiedId = await this.unclassifiedId(tenantId);
    const where: Prisma.ProductWhereInput = {
      ...scope,
      ...(unclassifiedId
        ? {
            OR: [
              {
                categoryMaps: {
                  none: { dimension: "COMMERCIAL", isPrimary: true },
                },
              },
              {
                categoryMaps: {
                  some: {
                    dimension: "COMMERCIAL",
                    isPrimary: true,
                    categoryId: unclassifiedId,
                  },
                },
              },
            ],
          }
        : {
            categoryMaps: {
              none: { dimension: "COMMERCIAL", isPrimary: true },
            },
          }),
    };

    const canonicalIds = await this.taxonomy.commercialCanonicalIds(tenantId);
    const categories = await this.prisma.productCategory.findMany({
      where: { tenantId, dimension: "COMMERCIAL" },
      select: { id: true, name: true, parentCategoryId: true },
    });
    const nameById = new Map(categories.map((c) => [c.id, c.name]));
    const parentById = new Map(
      categories.map((c) => [c.id, c.parentCategoryId]),
    );

    const seen: string[] = [];
    const pending: PendingTask[] = [];

    for await (const batch of this.pageProducts(where)) {
      for (const row of batch) {
        seen.push(row.id);
        const hit = classifyMedicine(
          row.genericName,
          row.name,
          row.dosageForm,
          row.brandName,
        );
        const categoryId = hit ? canonicalIds.get(hit.canonicalKey) : undefined;
        // The Unclassified floor is what the task is *about* — proposing it is a no-op.
        const usable =
          categoryId && categoryId !== unclassifiedId
            ? { categoryId, confidence: hit!.confidence }
            : null;

        const suggestion = usable
          ? {
              categoryId: usable.categoryId,
              categoryName: nameById.get(usable.categoryId) ?? "",
              categoryPath: this.pathOf(
                usable.categoryId,
                nameById,
                parentById,
              ),
            }
          : null;

        const safety = classifyTaskSafety({
          type: "MISSING_CATEGORY",
          evidence: usable ? this.categoryEvidence(row) : null,
          confidence: usable?.confidence ?? null,
          complianceImpact: false,
          identifierAmbiguous: false,
          candidateCount: usable ? 1 : 0,
          alreadyLinked: false,
          referenceClaimed: false,
        });

        pending.push({
          productId: row.id,
          type: "MISSING_CATEGORY",
          status: safety.status,
          suggestion,
          evidence: usable ? this.categoryEvidence(row) : null,
          confidence: usable?.confidence ?? null,
          complianceImpact: false,
          safeToApply: safety.safeToApply,
          candidates: null,
          importId: importId ?? row.importId,
          resolutionNote: null,
        });
      }
    }

    const written = await this.writeTasks(tenantId, pending);
    const closed = await this.closeStaleTasks(
      tenantId,
      "MISSING_CATEGORY",
      seen,
      scope,
    );
    return { ...written, closed };
  }

  /** NMRA_MATCH / NMRA_AMBIGUOUS, for products that could plausibly be registered medicines. */
  private async refreshNmraTasks(
    tenantId: string,
    scope: Prisma.ProductWhereInput,
    importId?: string,
  ) {
    const where: Prisma.ProductWhereInput = {
      ...scope,
      source: { not: "NMRA" },
      nmraReferenceId: null,
    };

    const seen: string[] = [];
    const pending: PendingTask[] = [];

    for await (const batch of this.pageProducts(where)) {
      const canonicalByProduct = await this.commercialCanonicalKeys(
        tenantId,
        batch.map((r) => r.id),
      );

      const matchable: ProductRow[] = [];
      const eligibilityByProduct = new Map<
        string,
        ReturnType<typeof classifyNmraEligibility>
      >();
      for (const row of batch) {
        const eligibility = classifyNmraEligibility({
          name: row.name,
          genericName: row.genericName,
          dosageForm: row.dosageForm,
          strength: row.strength,
          registrationNo: row.registrationNo,
          schedule: row.schedule,
          regType: row.regType,
          isControlled: row.isControlled,
          requiresPrescription: row.requiresPrescription,
          commercialCanonicalKey: canonicalByProduct.get(row.id) ?? null,
        });

        seen.push(row.id);
        eligibilityByProduct.set(row.id, eligibility);

        if (eligibility.verdict === "not_applicable") {
          // Recorded rather than skipped: the exclusion is then visible under the
          // "Not applicable" filter, explainable, and reversible by a person who disagrees.
          pending.push({
            productId: row.id,
            type: "NMRA_MATCH",
            status: "NOT_APPLICABLE",
            suggestion: null,
            evidence: null,
            confidence: null,
            complianceImpact: false,
            safeToApply: false,
            candidates: null,
            importId: importId ?? row.importId,
            resolutionNote: eligibility.reason,
          });
          continue;
        }
        matchable.push(row);
      }

      if (matchable.length === 0) continue;

      const keys = matchable.map((r) => ({
        name: r.name,
        barcode: r.barcode,
        registrationNo: r.registrationNo,
        genericName: r.genericName,
        strength: r.strength,
        dosageForm: r.dosageForm,
      }));
      const set = await this.finder.forMany(tenantId, keys);
      const index = new CatalogIndex(set.candidates);

      for (const row of matchable) {
        const rowKeys = {
          name: row.name,
          barcode: row.barcode,
          registrationNo: row.registrationNo,
          genericName: row.genericName,
          strength: row.strength,
          dosageForm: row.dosageForm,
        };

        // Ambiguity beats everything: if the product's own identifier lands on more than one
        // register row, no amount of ranking makes picking one of them defensible.
        const barcodeKey = (row.barcode ?? "")
          .replace(/\s+/g, "")
          .toLowerCase();
        const regKey = (row.registrationNo ?? "")
          .replace(/\s+/g, "")
          .toLowerCase();
        const collision =
          (barcodeKey && set.ambiguousByBarcode.get(barcodeKey)) ||
          (regKey && set.ambiguousByRegistration.get(regKey)) ||
          null;

        if (collision && collision.length > 1) {
          const field =
            barcodeKey && set.ambiguousByBarcode.has(barcodeKey)
              ? "barcode"
              : "registration number";
          pending.push({
            productId: row.id,
            type: "NMRA_AMBIGUOUS",
            status: "NEEDS_REVIEW",
            suggestion: null,
            evidence:
              barcodeKey && set.ambiguousByBarcode.has(barcodeKey)
                ? "barcode"
                : "registration",
            confidence: null,
            complianceImpact: collision.some(
              (c) =>
                c.isControlled !== row.isControlled ||
                c.requiresPrescription !== row.requiresPrescription,
            ),
            safeToApply: false,
            candidates: collision.map((c) => ({
              id: c.id,
              name: c.name,
              brandName: c.brandName,
              registrationNo: c.registrationNo,
            })),
            importId: importId ?? row.importId,
            resolutionNote: `The ${field} "${row.barcode ?? row.registrationNo}" matches ${collision.length} register entries.`,
          });
          continue;
        }

        const ranked = index.rankedCandidates(rowKeys, 5);
        const top = ranked[0];

        if (!top) {
          /*
           * Nothing matched. Only worth a row when the product carries a *regulatory* signal —
           * a registration number, a schedule, a compliance flag. That is a real discrepancy:
           * something says this is registered and the register disagrees.
           *
           * A weak signal is not. Running this against a real catalog, "Hand Sanitizer Gel
           * 100ml", "Body Lotion 400ml" and "Wheat Baby Cereal 400g" all queued here, because
           * "gel"/"lotion" are dosage forms and "100ml"/"400g" are dosed strengths. Twenty
           * unactionable rows for every real one is how a worklist stops being read.
           */
          if (eligibilityByProduct.get(row.id)?.tier !== "regulatory") continue;
          pending.push({
            productId: row.id,
            type: "NMRA_MATCH",
            status: "OPEN",
            suggestion: null,
            evidence: null,
            confidence: null,
            complianceImpact: false,
            safeToApply: false,
            candidates: null,
            importId: importId ?? row.importId,
            resolutionNote:
              "No register entry matched — search the register or leave it unlinked.",
          });
          continue;
        }

        const complianceImpact =
          top.candidate.isControlled !== row.isControlled ||
          top.candidate.requiresPrescription !== row.requiresPrescription;

        const safety = classifyTaskSafety({
          type: "NMRA_MATCH",
          evidence: top.evidence,
          confidence: confidenceForEvidence(top.evidence),
          complianceImpact,
          identifierAmbiguous: false,
          candidateCount: 1,
          alreadyLinked: Boolean(row.nmraReferenceId),
          referenceClaimed: false,
        });

        pending.push({
          productId: row.id,
          type: "NMRA_MATCH",
          status: safety.status,
          suggestion: {
            referenceProductId: top.candidate.id,
            name: top.candidate.name,
            brandName: top.candidate.brandName,
            registrationNo: top.candidate.registrationNo,
            isControlled: top.candidate.isControlled,
            requiresPrescription: top.candidate.requiresPrescription,
          },
          evidence: top.evidence,
          confidence: confidenceForEvidence(top.evidence),
          complianceImpact,
          safeToApply: safety.safeToApply,
          candidates: ranked.map((r) => ({
            id: r.candidate.id,
            name: r.candidate.name,
            brandName: r.candidate.brandName,
            registrationNo: r.candidate.registrationNo,
          })),
          importId: importId ?? row.importId,
          resolutionNote:
            safety.blockers.length > 0 ? safety.blockers.join(" ") : null,
        });
      }
    }

    const written = await this.writeTasks(tenantId, pending);
    const closed =
      (await this.closeStaleTasks(tenantId, "NMRA_MATCH", seen, scope)) +
      (await this.closeStaleTasks(tenantId, "NMRA_AMBIGUOUS", seen, scope));
    return { ...written, closed };
  }

  /**
   * Write a batch of pending tasks, leaving every terminal row alone.
   *
   * A dismissed task must stay dismissed across refreshes — otherwise the queue re-asks a
   * question that was already answered, which is precisely the behaviour that made the old
   * recompute-on-load screens unusable. The exception is a NOT_APPLICABLE row the classifier
   * itself wrote: re-stating it keeps the reason current if the product's data changed.
   */
  private async writeTasks(tenantId: string, pending: PendingTask[]) {
    if (pending.length === 0) return { created: 0, updated: 0 };

    const existing = await this.prisma.catalogTask.findMany({
      where: {
        tenantId,
        productId: { in: pending.map((p) => p.productId) },
        type: { in: [...new Set(pending.map((p) => p.type))] },
      },
      select: {
        id: true,
        productId: true,
        type: true,
        status: true,
        resolvedByUserId: true,
      },
    });
    const existingByKey = new Map(
      existing.map((e) => [`${e.productId}:${e.type}`, e]),
    );

    let created = 0;
    let updated = 0;

    for (const task of pending) {
      const prior = existingByKey.get(`${task.productId}:${task.type}`);
      if (!prior) {
        await this.prisma.catalogTask.create({
          data: {
            tenantId,
            productId: task.productId,
            type: task.type,
            status: task.status,
            suggestion: task.suggestion ?? Prisma.DbNull,
            evidence: task.evidence,
            confidence: task.confidence,
            complianceImpact: task.complianceImpact,
            safeToApply: task.safeToApply,
            candidates: task.candidates ?? Prisma.DbNull,
            importId: task.importId,
            resolutionNote: task.resolutionNote,
            ...(task.status === "NOT_APPLICABLE"
              ? { resolvedAt: new Date() }
              : {}),
          },
        });
        created += 1;
        continue;
      }

      const terminal =
        prior.status === "RESOLVED" ||
        prior.status === "DISMISSED" ||
        // Only a person's NOT_APPLICABLE is protected; the classifier's own is refreshable.
        (prior.status === "NOT_APPLICABLE" && prior.resolvedByUserId !== null);
      if (terminal) continue;

      await this.prisma.catalogTask.update({
        where: { id: prior.id, tenantId },
        data: {
          status: task.status,
          suggestion: task.suggestion ?? Prisma.DbNull,
          evidence: task.evidence,
          confidence: task.confidence,
          complianceImpact: task.complianceImpact,
          safeToApply: task.safeToApply,
          candidates: task.candidates ?? Prisma.DbNull,
          importId: task.importId ?? undefined,
          resolutionNote: task.resolutionNote,
          ...(task.status === "NOT_APPLICABLE"
            ? { resolvedAt: new Date() }
            : { resolvedAt: null }),
        },
      });
      updated += 1;
    }

    return { created, updated };
  }

  /**
   * Close open tasks whose product no longer needs them — it picked up a category, or got
   * linked. Scoped to the same product set the pass examined, so a partial refresh
   * (one import, one product) never closes work outside its scope.
   */
  private async closeStaleTasks(
    tenantId: string,
    type: CatalogTaskType,
    stillOpenProductIds: string[],
    scope: Prisma.ProductWhereInput,
  ): Promise<number> {
    const result = await this.prisma.catalogTask.updateMany({
      where: {
        tenantId,
        type,
        status: { in: OPEN_STATUSES },
        productId: {
          notIn: stillOpenProductIds.length > 0 ? stillOpenProductIds : [""],
        },
        product: scope,
      },
      data: {
        status: "RESOLVED",
        resolvedAt: new Date(),
        resolutionNote:
          "Resolved elsewhere — this product no longer needs the change.",
      },
    });
    return result.count;
  }

  private async *pageProducts(where: Prisma.ProductWhereInput) {
    let cursor: string | undefined;
    let fetched = 0;
    for (;;) {
      const batch: ProductRow[] = await this.prisma.product.findMany({
        where,
        select: PRODUCT_SELECT,
        orderBy: { id: "asc" },
        take: REFRESH_BATCH,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (batch.length === 0) return;
      yield batch;
      fetched += batch.length;
      if (batch.length < REFRESH_BATCH || fetched >= REFRESH_MAX_PRODUCTS) {
        if (fetched >= REFRESH_MAX_PRODUCTS) {
          this.logger.warn(
            `Catalog task refresh stopped at ${REFRESH_MAX_PRODUCTS} products; run again to continue.`,
          );
        }
        return;
      }
      cursor = batch[batch.length - 1].id;
    }
  }

  // ───────────────────────────── reading ─────────────────────────────

  async summary(tenantId: string): Promise<CatalogTaskSummary> {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const open = { tenantId, status: { in: OPEN_STATUSES } } as const;

    const [
      openCount,
      needsCategory,
      nmraMatch,
      complianceReview,
      ambiguous,
      noSuggestion,
      safeToApply,
      fromRecentImports,
      resolved,
      dismissed,
      notApplicable,
      ranged,
    ] = await Promise.all([
      this.prisma.catalogTask.count({ where: open }),
      this.prisma.catalogTask.count({
        where: { ...open, type: "MISSING_CATEGORY" },
      }),
      this.prisma.catalogTask.count({ where: { ...open, type: "NMRA_MATCH" } }),
      this.prisma.catalogTask.count({
        where: { ...open, complianceImpact: true },
      }),
      // The same rows the "ambiguous" view returns — an import duplicate is an ambiguous
      // identifier too. Counting only NMRA_AMBIGUOUS here made the chip promise fewer rows
      // than clicking it produced.
      this.prisma.catalogTask.count({
        where: { ...open, type: { in: AMBIGUOUS_TYPES } },
      }),
      this.prisma.catalogTask.count({ where: { ...open, evidence: null } }),
      this.prisma.catalogTask.count({ where: { ...open, safeToApply: true } }),
      this.prisma.catalogTask.count({
        where: { ...open, import: { createdAt: { gte: weekAgo } } },
      }),
      this.prisma.catalogTask.count({
        where: { tenantId, status: "RESOLVED" },
      }),
      this.prisma.catalogTask.count({
        where: { tenantId, status: "DISMISSED" },
      }),
      this.prisma.catalogTask.count({
        where: { tenantId, status: "NOT_APPLICABLE" },
      }),
      this.prisma.product.count({ where: { tenantId, rangeStatus: "RANGED" } }),
    ]);

    return {
      open: openCount,
      needsCategory,
      nmraMatch,
      complianceReview,
      ambiguous,
      noSuggestion,
      safeToApply,
      fromRecentImports,
      resolved,
      dismissed,
      notApplicable,
      // Coverage is the inverse of the open category queue: every ranged product either has a
      // real category or has a task saying it doesn't.
      categoryCoveragePercent:
        ranged === 0
          ? 100
          : Math.round(
              ((ranged - Math.min(needsCategory, ranged)) / ranged) * 100,
            ),
    };
  }

  async list(
    tenantId: string,
    filter: CatalogTaskFilter,
  ): Promise<CatalogTaskListResult> {
    const take = Math.min(Math.max(1, filter.take ?? DEFAULT_TAKE), MAX_TAKE);
    const skip = Math.max(0, filter.skip ?? 0);
    const where = this.buildWhere(tenantId, filter);

    const [rows, total, counts] = await Promise.all([
      this.prisma.catalogTask.findMany({
        where,
        orderBy: [{ status: "asc" }, { createdAt: "desc" }],
        skip,
        take,
        include: {
          product: { select: PRODUCT_SELECT },
          import: { select: { filename: true } },
          resolvedBy: { select: { fullName: true } },
        },
      }),
      this.prisma.catalogTask.count({ where }),
      this.facetCounts(tenantId, filter),
    ]);

    return {
      items: rows.map((row) => this.toView(row)),
      total,
      skip,
      take,
      counts,
    };
  }

  /**
   * How many tasks each filter chip would return, given everything else already chosen.
   *
   * The queue's two chip rows are two axes over one list, so a count on either only means
   * something relative to the other: with "Resolved" selected, "Needs category" has to say how
   * many *resolved* category tasks there are. Counting each chip against the whole tenant
   * instead — which is what a filter-blind summary does — puts a number on a chip that the
   * table contradicts the moment it is clicked.
   */
  private async facetCounts(
    tenantId: string,
    filter: CatalogTaskFilter,
  ): Promise<CatalogTaskFacetCounts> {
    // Each axis is counted with itself dropped from the filter and every other clause kept.
    const acrossTypes = this.buildWhere(tenantId, filter, { omitType: true });
    const acrossStatuses = this.buildWhere(tenantId, filter, {
      omitStatus: true,
    });
    const where = this.buildWhere(tenantId, filter);

    const [byType, compliance, noSuggestion, byStatus, safeToApply] =
      await Promise.all([
        this.prisma.catalogTask.groupBy({
          by: ["type"],
          where: acrossTypes,
          _count: { _all: true },
        }),
        this.prisma.catalogTask.count({
          where: { ...acrossTypes, complianceImpact: true },
        }),
        this.prisma.catalogTask.count({
          where: { ...acrossTypes, evidence: null },
        }),
        this.prisma.catalogTask.groupBy({
          by: ["status"],
          where: acrossStatuses,
          _count: { _all: true },
        }),
        this.prisma.catalogTask.count({
          where: { ...where, safeToApply: true },
        }),
      ]);

    const typeCount = (type: CatalogTaskType) =>
      byType.find((row) => row.type === type)?._count._all ?? 0;
    const statusCount = (status: CatalogTaskStatus) =>
      byStatus.find((row) => row.status === status)?._count._all ?? 0;

    return {
      all: byType.reduce((sum, row) => sum + row._count._all, 0),
      needsCategory: typeCount("MISSING_CATEGORY"),
      nmraMatch: typeCount("NMRA_MATCH"),
      compliance,
      ambiguous: AMBIGUOUS_TYPES.reduce((sum, t) => sum + typeCount(t), 0),
      noSuggestion,
      open: OPEN_STATUSES.reduce((sum, st) => sum + statusCount(st), 0),
      resolved: statusCount("RESOLVED"),
      dismissed: statusCount("DISMISSED"),
      notApplicable: statusCount("NOT_APPLICABLE"),
      safeToApply,
    };
  }

  private buildWhere(
    tenantId: string,
    filter: CatalogTaskFilter,
    omit: { omitStatus?: boolean; omitType?: boolean } = {},
  ): Prisma.CatalogTaskWhereInput {
    const where: Prisma.CatalogTaskWhereInput = { tenantId };

    if (!omit.omitStatus) {
      where.status = {
        in: filter.status?.length ? filter.status : OPEN_STATUSES,
      };
    }
    if (!omit.omitType && filter.type?.length) where.type = { in: filter.type };
    if (filter.importId) where.importId = filter.importId;
    if (filter.source) where.product = { source: filter.source as never };
    if (filter.createdFrom || filter.createdTo) {
      where.createdAt = {
        ...(filter.createdFrom ? { gte: filter.createdFrom } : {}),
        ...(filter.createdTo ? { lte: filter.createdTo } : {}),
      };
    }

    // The cross-cutting views narrow the same axis the type chips do, so counting "how many
    // per type" drops them along with `filter.type`. "safe" is not one of those chips — it
    // scopes `applySafe` — so it survives either way.
    switch (omit.omitType && filter.view !== "safe" ? undefined : filter.view) {
      case "compliance":
        where.complianceImpact = true;
        break;
      case "ambiguous":
        where.type = { in: AMBIGUOUS_TYPES };
        break;
      case "no_suggestion":
        where.evidence = null;
        break;
      case "safe":
        where.safeToApply = true;
        break;
      default:
        break;
    }

    if (filter.q?.trim()) {
      const q = filter.q.trim();
      where.product = {
        ...(where.product as Prisma.ProductWhereInput | undefined),
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { sku: { contains: q, mode: "insensitive" } },
          { brandName: { contains: q, mode: "insensitive" } },
          { genericName: { contains: q, mode: "insensitive" } },
          { barcode: { contains: q, mode: "insensitive" } },
          { registrationNo: { contains: q, mode: "insensitive" } },
        ],
      };
    }

    return where;
  }

  private toView(row: {
    id: string;
    type: CatalogTaskType;
    status: CatalogTaskStatus;
    suggestion: Prisma.JsonValue;
    evidence: string | null;
    confidence: Prisma.Decimal | null;
    complianceImpact: boolean;
    safeToApply: boolean;
    candidates: Prisma.JsonValue;
    importId: string | null;
    sourceRow: number | null;
    createdAt: Date;
    resolvedAt: Date | null;
    resolutionNote: string | null;
    product: ProductRow;
    import: { filename: string } | null;
    resolvedBy: { fullName: string } | null;
  }): CatalogTaskView {
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      product: {
        id: row.product.id,
        name: row.product.name,
        sku: row.product.sku,
        brandName: row.product.brandName,
        genericName: row.product.genericName,
        dosageForm: row.product.dosageForm,
        strength: row.product.strength,
        barcode: row.product.barcode,
        registrationNo: row.product.registrationNo,
        source: row.product.source,
        isControlled: row.product.isControlled,
        requiresPrescription: row.product.requiresPrescription,
      },
      suggestion: (row.suggestion as CatalogTaskView["suggestion"]) ?? null,
      evidence: row.evidence,
      evidenceLabel: evidenceLabel(row.evidence),
      confidence: row.confidence ? Number(row.confidence) : null,
      complianceImpact: row.complianceImpact,
      safeToApply: row.safeToApply,
      candidates: (row.candidates as CatalogTaskView["candidates"]) ?? [],
      importId: row.importId,
      importFilename: row.import?.filename ?? null,
      sourceRow: row.sourceRow,
      detail: row.resolutionNote,
      createdAt: row.createdAt.toISOString(),
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      resolvedBy: row.resolvedBy?.fullName ?? null,
      resolutionNote: row.resolutionNote,
    };
  }

  // ───────────────────────────── acting ─────────────────────────────

  /**
   * Apply one task's resolution. `override` lets the operator choose a different category or a
   * different register row than the one suggested — the common case on anything ambiguous, and
   * the reason a task carries candidates rather than a single answer.
   */
  async apply(
    tenantId: string,
    userId: string,
    taskId: string,
    override?: { categoryId?: string; referenceProductId?: string },
  ): Promise<CatalogTaskView> {
    const task = await this.loadTask(tenantId, taskId);
    if (task.status === "RESOLVED") {
      throw new BadRequestException("This task has already been resolved.");
    }

    if (task.type === "MISSING_CATEGORY") {
      const suggestion = task.suggestion as { categoryId?: string } | null;
      const categoryId = override?.categoryId ?? suggestion?.categoryId;
      if (!categoryId) {
        throw new BadRequestException(
          "Choose a category — this task has no suggestion to apply.",
        );
      }
      const category = await this.prisma.productCategory.findFirst({
        where: { tenantId, id: categoryId, dimension: "COMMERCIAL" },
        select: { id: true },
      });
      if (!category) throw new NotFoundException("Category not found.");
      await this.taxonomy.setPrimaryCommercialCategory(
        tenantId,
        task.productId,
        categoryId,
        {
          assignmentSource: "MANUAL",
        },
      );
    } else {
      const suggestion = task.suggestion as {
        referenceProductId?: string;
      } | null;
      const referenceProductId =
        override?.referenceProductId ?? suggestion?.referenceProductId;
      if (!referenceProductId) {
        throw new BadRequestException(
          "Choose a register entry — this task has no single match to apply.",
        );
      }
      // Goes through the link service so the field-ownership policy, the undo snapshot and the
      // audit entry are identical to a link made from the product page. There is exactly one
      // way to link a product, and this is not a second one.
      await this.nmraLink.link(
        tenantId,
        userId,
        task.productId,
        referenceProductId,
      );
    }

    return this.close(tenantId, userId, taskId, "RESOLVED", null);
  }

  async dismiss(
    tenantId: string,
    userId: string,
    taskId: string,
    note?: string,
  ) {
    return this.close(tenantId, userId, taskId, "DISMISSED", note ?? null);
  }

  async markNotApplicable(
    tenantId: string,
    userId: string,
    taskId: string,
    note?: string,
  ) {
    return this.close(tenantId, userId, taskId, "NOT_APPLICABLE", note ?? null);
  }

  /** Put a closed task back in the queue — the manual override for a wrong exclusion. */
  async reopen(
    tenantId: string,
    userId: string,
    taskId: string,
  ): Promise<CatalogTaskView> {
    const task = await this.loadTask(tenantId, taskId);
    await this.prisma.catalogTask.update({
      where: { id: task.id, tenantId },
      data: {
        status: task.complianceImpact ? "NEEDS_REVIEW" : "OPEN",
        resolvedAt: null,
        resolvedByUserId: null,
        resolutionNote: null,
      },
    });
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      eventName: "catalog_task.reopened",
      entityName: "catalog_task",
      entityId: task.id,
      payload: { type: task.type, productId: task.productId },
    });
    return this.view(tenantId, taskId);
  }

  private async close(
    tenantId: string,
    userId: string,
    taskId: string,
    status: CatalogTaskStatus,
    note: string | null,
  ): Promise<CatalogTaskView> {
    const task = await this.loadTask(tenantId, taskId);
    await this.prisma.catalogTask.update({
      where: { id: task.id, tenantId },
      data: {
        status,
        resolvedAt: new Date(),
        resolvedByUserId: userId,
        resolutionNote: note ?? task.resolutionNote,
      },
    });
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      eventName: `catalog_task.${status.toLowerCase()}`,
      entityName: "catalog_task",
      entityId: task.id,
      payload: { type: task.type, productId: task.productId, note },
    });
    return this.view(tenantId, taskId);
  }

  /**
   * Apply every task that meets the safe conditions, within the caller's current filter.
   *
   * The filter matters: the count on the button is computed from the same `where` clause, so
   * "Apply 18 safe changes" applies exactly the eighteen the operator was looking at, not
   * every safe task in the tenant.
   */
  async applySafe(
    tenantId: string,
    userId: string,
    filter: CatalogTaskFilter,
  ): Promise<{
    applied: number;
    failed: Array<{ taskId: string; reason: string }>;
  }> {
    const where = {
      ...this.buildWhere(tenantId, filter),
      safeToApply: true,
      status: { in: OPEN_STATUSES },
    };
    const tasks = await this.prisma.catalogTask.findMany({
      where,
      select: { id: true },
      take: MAX_TAKE,
    });

    let applied = 0;
    const failed: Array<{ taskId: string; reason: string }> = [];
    for (const task of tasks) {
      try {
        await this.apply(tenantId, userId, task.id);
        applied += 1;
      } catch (err) {
        failed.push({
          taskId: task.id,
          reason:
            err instanceof Error ? err.message : "Could not apply this change.",
        });
      }
    }

    await this.audit.log({
      tenantId,
      actorUserId: userId,
      eventName: "catalog_task.apply_safe",
      entityName: "catalog_task",
      entityId: tasks[0]?.id ?? "00000000-0000-0000-0000-000000000000",
      payload: { requested: tasks.length, applied, failed: failed.length },
    });

    return { applied, failed };
  }

  async view(tenantId: string, taskId: string): Promise<CatalogTaskView> {
    const row = await this.prisma.catalogTask.findFirst({
      where: { tenantId, id: taskId },
      include: {
        product: { select: PRODUCT_SELECT },
        import: { select: { filename: true } },
        resolvedBy: { select: { fullName: true } },
      },
    });
    if (!row) throw new NotFoundException("Task not found.");
    return this.toView(row);
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private async loadTask(tenantId: string, taskId: string) {
    const task = await this.prisma.catalogTask.findFirst({
      where: { tenantId, id: taskId },
    });
    if (!task) throw new NotFoundException("Task not found.");
    return task;
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

  private async commercialCanonicalKeys(
    tenantId: string,
    productIds: string[],
  ): Promise<Map<string, string | null>> {
    const maps = await this.prisma.productCategoryMap.findMany({
      where: {
        tenantId,
        productId: { in: productIds },
        dimension: "COMMERCIAL",
        isPrimary: true,
      },
      select: { productId: true, category: { select: { canonicalKey: true } } },
    });
    return new Map(maps.map((m) => [m.productId, m.category.canonicalKey]));
  }

  private pathOf(
    categoryId: string,
    nameById: Map<string, string>,
    parentById: Map<string, string | null>,
  ): string {
    const name = nameById.get(categoryId) ?? "";
    const parentId = parentById.get(categoryId);
    const parentName = parentId ? nameById.get(parentId) : undefined;
    return parentName ? `${parentName} › ${name}` : name;
  }

  /** Which signal the category classifier actually used, so the evidence column can say. */
  private categoryEvidence(row: ProductRow): string {
    if (row.genericName?.trim()) return "generic_rule";
    return "name_rule";
  }
}

/**
 * A number for an evidence tier, so the queue can sort and threshold consistently. Not a
 * probability — an ordering the UI renders as a percentage, matching how the import wizard
 * already presents its own tiers.
 */
export function confidenceForEvidence(evidence: string | null): number | null {
  switch (evidence) {
    case "barcode":
      return 0.99;
    case "registration":
      return 0.98;
    case "name":
      return 0.95;
    case "normalized":
      return 0.8;
    case "fuzzy":
      return 0.65;
    case "inn_head":
      return 0.5;
    default:
      return null;
  }
}
