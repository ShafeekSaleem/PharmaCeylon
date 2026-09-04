import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import {
  CategoryTaxonomyService,
  type RegulatoryDimension,
} from "../catalog/category-taxonomy.service";
import { UNCLASSIFIED_MEDICINES_CANONICAL_KEY } from "../catalog/commercial-category-template";
import {
  createNmraJob,
  getNmraJob,
  patchNmraJob,
  toNmraJobProgress,
  type NmraJobProgress,
} from "./nmra-import-jobs";
import {
  buildNmraMutableFields,
  chunkArray,
  nmraAliasDraftsForRow,
  nmraCategoryKeysForRow,
  NMRA_TAG_DEFS,
  type ExistingForNmraUpsert,
} from "./nmra-import-merge";
import type { NmraImportPreview, NmraImportResult } from "./nmra-import.types";
import {
  loadNmraProductsFromBuffer,
  type NmraProductRow,
} from "./nmra-normalize";

export type { NmraImportPreview, NmraImportResult } from "./nmra-import.types";

/** Product create/update batch size — sequential batches avoid pg concurrent-query misuse. */
const PRODUCT_BATCH = 75;
/** Relation createMany batch size. */
const RELATION_BATCH = 400;
/** Extra progress units for taxonomy / tags / aliases phases. */
const RELATION_PHASES = 3;

type UpsertProgress = {
  phase: string;
  processed: number;
  total: number;
  created: number;
  updated: number;
  skipped: number;
  errorCount: number;
};

@Injectable()
export class NmraImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly categoryTaxonomy: CategoryTaxonomyService,
  ) {}

  private parseFile(file: Express.Multer.File): NmraProductRow[] {
    if (!file?.buffer?.length) {
      throw new BadRequestException("Upload an NMRA Excel or CSV file.");
    }
    const name = (file.originalname ?? "").toLowerCase();
    if (!/\.(xlsx?|csv)$/.test(name) && !name.includes("xls")) {
      // Allow odd NMRA filenames that omit extension when mimetype is spreadsheet-like.
      const okMime =
        /sheet|excel|csv|octet-stream/i.test(file.mimetype ?? "") ||
        name.length === 0;
      if (!okMime) {
        throw new BadRequestException(
          "Unsupported file type. Upload the NMRA Valid Registration Excel (.xls/.xlsx) or CSV export.",
        );
      }
    }
    try {
      return loadNmraProductsFromBuffer(file.buffer, { filename: file.originalname });
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : "Failed to parse NMRA file",
      );
    }
  }

  async preview(tenantId: string, file: Express.Multer.File): Promise<NmraImportPreview> {
    const rows = this.parseFile(file);
    const regNos = [...new Set(rows.map((r) => r.registrationNo))];
    const existing = await this.prisma.product.findMany({
      where: { tenantId, registrationNo: { in: regNos } },
      select: { id: true, registrationNo: true, name: true, sku: true },
    });
    const byReg = new Map(
      existing
        .filter((e) => e.registrationNo)
        .map((e) => [e.registrationNo!, e]),
    );

    let create = 0;
    let update = 0;
    let skip = 0;
    const errors: NmraImportPreview["errors"] = [];
    const sampleCreates: NmraImportPreview["sampleCreates"] = [];
    const sampleUpdates: NmraImportPreview["sampleUpdates"] = [];

    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.registrationNo)) {
        skip += 1;
        continue;
      }
      seen.add(row.registrationNo);
      const match = byReg.get(row.registrationNo);
      if (!match) {
        create += 1;
        if (sampleCreates.length < 8) {
          sampleCreates.push({
            registrationNo: row.registrationNo,
            name: row.name,
            brandName: row.brandName,
          });
        }
      } else {
        update += 1;
        if (sampleUpdates.length < 8) {
          sampleUpdates.push({
            registrationNo: row.registrationNo,
            name: row.name,
            existingName: match.name,
          });
        }
      }
    }

    if (rows.length === 0) {
      errors.push({
        message:
          "No NMRA product rows found. Expect a Valid Registration export with a REG.NO. column.",
      });
    }

    return {
      totalRows: rows.length,
      create,
      update,
      skip,
      errors,
      sampleCreates,
      sampleUpdates,
    };
  }

  /**
   * Start async confirm upsert. Returns jobId immediately; poll getJobProgress.
   * Parse/validate happens before the response so bad files fail fast.
   */
  startUpsertJob(
    tenantId: string,
    userId: string,
    file: Express.Multer.File,
  ): { jobId: string } {
    const rows = this.parseFile(file);
    if (rows.length === 0) {
      throw new BadRequestException(
        "No NMRA product rows found. Download the Valid Registration list from NMRA, then upload here.",
      );
    }
    const jobId = randomUUID();
    createNmraJob(jobId, tenantId);
    void this.runUpsertJob(jobId, tenantId, userId, rows);
    return { jobId };
  }

  getJobProgress(tenantId: string, jobId: string): NmraJobProgress {
    const job = getNmraJob(jobId);
    if (!job || job.tenantId !== tenantId) {
      throw new NotFoundException("Import job not found.");
    }
    return toNmraJobProgress(job);
  }

  private async runUpsertJob(
    jobId: string,
    tenantId: string,
    userId: string,
    rows: NmraProductRow[],
  ): Promise<void> {
    patchNmraJob(jobId, { status: "running", phase: "preparing" });
    try {
      const result = await this.upsertRows(tenantId, userId, rows, (p) => {
        patchNmraJob(jobId, {
          status: "running",
          phase: p.phase,
          processed: p.processed,
          total: p.total,
          created: p.created,
          updated: p.updated,
          skipped: p.skipped,
          errorCount: p.errorCount,
        });
      });
      const current = getNmraJob(jobId);
      patchNmraJob(jobId, {
        status: "completed",
        phase: "done",
        processed: current?.total ?? result.created + result.updated,
        total: current?.total ?? result.created + result.updated,
        created: result.created,
        updated: result.updated,
        skipped: result.skipped,
        errorCount: result.errors.length,
        result,
      });
    } catch (err) {
      patchNmraJob(jobId, {
        status: "failed",
        phase: "failed",
        error: err instanceof Error ? err.message : "NMRA import failed",
      });
    }
  }

  /**
   * Confirm upsert: batched sequential writes (no Promise.all on one client).
   * See merge policy in nmra-import-merge.ts — NMRA scalars update; tags/aliases/categories merge-add.
   */
  async upsert(
    tenantId: string,
    userId: string,
    file: Express.Multer.File,
  ): Promise<NmraImportResult> {
    const rows = this.parseFile(file);
    if (rows.length === 0) {
      throw new BadRequestException(
        "No NMRA product rows found. Download the Valid Registration list from NMRA, then upload here.",
      );
    }
    return this.upsertRows(tenantId, userId, rows);
  }

  private async upsertRows(
    tenantId: string,
    userId: string,
    rows: NmraProductRow[],
    onProgress?: (p: UpsertProgress) => void,
  ): Promise<NmraImportResult> {
    const uniqueRows: NmraProductRow[] = [];
    const seen = new Set<string>();
    let skipped = 0;
    for (const row of rows) {
      if (seen.has(row.registrationNo)) {
        skipped += 1;
        continue;
      }
      seen.add(row.registrationNo);
      uniqueRows.push(row);
    }

    const emit = (partial: Omit<UpsertProgress, "skipped">) => {
      onProgress?.({ ...partial, skipped });
    };

    emit({
      phase: "preparing",
      processed: 0,
      total: 0,
      created: 0,
      updated: 0,
      errorCount: 0,
    });

    const regNos = uniqueRows.map((r) => r.registrationNo);
    const existing = await this.prisma.product.findMany({
      where: { tenantId, registrationNo: { in: regNos } },
      select: {
        id: true,
        registrationNo: true,
        sku: true,
        barcode: true,
      },
    });
    const byReg = new Map<string, ExistingForNmraUpsert>(
      existing
        .filter((e) => e.registrationNo)
        .map((e) => [e.registrationNo!, e]),
    );

    // Barcodes already claimed by other products in this tenant (conflict check).
    const fileBarcodes = [
      ...new Set(uniqueRows.map((r) => r.barcode).filter((b): b is string => Boolean(b))),
    ];
    const barcodeOwners = fileBarcodes.length
      ? await this.prisma.product.findMany({
          where: { tenantId, barcode: { in: fileBarcodes } },
          select: { id: true, barcode: true, registrationNo: true },
        })
      : [];
    const ownerByBarcode = new Map(
      barcodeOwners
        .filter((p) => p.barcode)
        .map((p) => [p.barcode!, p]),
    );

    const toCreate: Prisma.ProductCreateManyInput[] = [];
    const toUpdate: Array<{
      id: string;
      registrationNo: string;
      data: ReturnType<typeof buildNmraMutableFields>;
    }> = [];
    const errors: NmraImportResult["errors"] = [];

    for (const row of uniqueRows) {
      const match = byReg.get(row.registrationNo) ?? null;
      const fileBc = row.barcode;
      const owner = fileBc ? ownerByBarcode.get(fileBc) : undefined;
      const barcodeOwnedByOther =
        Boolean(owner && match && owner.id !== match.id) ||
        Boolean(owner && !match);

      const mutable = buildNmraMutableFields(row, match, { barcodeOwnedByOther });

      if (match) {
        toUpdate.push({
          id: match.id,
          registrationNo: row.registrationNo,
          data: mutable,
        });
      } else {
        const id = randomUUID();
        const barcode = barcodeOwnedByOther ? null : (mutable.barcode ?? null);
        toCreate.push({
          id,
          tenantId,
          sku: row.sku,
          registrationNo: row.registrationNo,
          taxCategory: "Standard rate",
          reorderLevel: 0,
          source: "NMRA",
          // The registry is a lookup library, not the shop's product list. Set on create
          // only — a re-import must never demote a product the pharmacy has since ranged.
          rangeStatus: "REFERENCE",
          ...mutable,
          barcode,
        });
        byReg.set(row.registrationNo, {
          id,
          registrationNo: row.registrationNo,
          sku: row.sku,
          barcode,
        });
        if (fileBc && !barcodeOwnedByOther) {
          ownerByBarcode.set(fileBc, {
            id,
            barcode: fileBc,
            registrationNo: row.registrationNo,
          });
        }
      }
    }

    const total = toCreate.length + toUpdate.length + RELATION_PHASES;
    let processed = 0;
    let created = 0;
    let updated = 0;

    emit({
      phase: toCreate.length ? "creating" : toUpdate.length ? "updating" : "taxonomy",
      processed,
      total,
      created,
      updated,
      errorCount: 0,
    });

    for (const chunk of chunkArray(toCreate, PRODUCT_BATCH)) {
      try {
        const res = await this.prisma.product.createMany({ data: chunk });
        created += res.count;
      } catch {
        // Fall back to per-row so one bad SKU doesn't abort the whole import.
        for (const item of chunk) {
          try {
            await this.prisma.product.create({ data: item });
            created += 1;
          } catch (rowErr) {
            errors.push({
              registrationNo: item.registrationNo ?? undefined,
              message: rowErr instanceof Error ? rowErr.message : "Create failed",
            });
            if (item.registrationNo) byReg.delete(item.registrationNo);
          }
        }
      }
      processed += chunk.length;
      emit({
        phase: "creating",
        processed,
        total,
        created,
        updated,
        errorCount: errors.length,
      });
    }

    // Sequential batches — never Promise.all on the same Prisma/pg client.
    for (const chunk of chunkArray(toUpdate, PRODUCT_BATCH)) {
      await this.prisma.$transaction(async (tx) => {
        for (const item of chunk) {
          try {
            await tx.product.update({
              where: { id: item.id, tenantId },
              data: item.data,
            });
            updated += 1;
          } catch (err) {
            errors.push({
              registrationNo: item.registrationNo,
              message: err instanceof Error ? err.message : "Update failed",
            });
          }
        }
      }, { timeout: 120_000, maxWait: 60_000 });
      processed += chunk.length;
      emit({
        phase: "updating",
        processed,
        total,
        created,
        updated,
        errorCount: errors.length,
      });
    }

    emit({
      phase: "taxonomy",
      processed,
      total,
      created,
      updated,
      errorCount: errors.length,
    });
    const categoryMapsAdded = await this.ensureNmraTaxonomy(tenantId, uniqueRows, byReg);
    processed += 1;
    emit({
      phase: "tags",
      processed,
      total,
      created,
      updated,
      errorCount: errors.length,
    });
    const tagsTouched = await this.ensureNmraTags(tenantId, uniqueRows, byReg);
    processed += 1;
    emit({
      phase: "aliases",
      processed,
      total,
      created,
      updated,
      errorCount: errors.length,
    });
    await this.ensureAliases(tenantId, uniqueRows, byReg);
    processed += 1;
    emit({
      phase: "done",
      processed,
      total,
      created,
      updated,
      errorCount: errors.length,
    });

    await this.audit.log({
      tenantId,
      actorUserId: userId,
      eventName: "products.nmra_import",
      entityName: "product",
      entityId: tenantId,
      payload: { created, updated, skipped, errorCount: errors.length },
    });

    return {
      parsed: rows.length,
      created,
      updated,
      skipped,
      errors,
      categoryMapsAdded,
      tagsTouched,
    };
  }

  private async ensureNmraTaxonomy(
    tenantId: string,
    rows: NmraProductRow[],
    byReg: Map<string, ExistingForNmraUpsert>,
  ): Promise<number> {
    const dimensionByParentName: Record<
      "Dosage form" | "NMRA Schedule" | "Registration type",
      RegulatoryDimension
    > = {
      "Dosage form": "DOSAGE_FORM",
      "NMRA Schedule": "NMRA_SCHEDULE",
      "Registration type": "REGISTRATION_TYPE",
    };

    const rootIds = await this.categoryTaxonomy.dimensionRootIds(tenantId);
    const parentIdByName = new Map<string, string>();
    for (const [parentName, dimension] of Object.entries(dimensionByParentName) as Array<
      [keyof typeof dimensionByParentName, RegulatoryDimension]
    >) {
      const id = rootIds[dimension] ?? (await this.categoryTaxonomy.ensureDimensionRoot(tenantId, dimension));
      parentIdByName.set(parentName, id);
    }

    const neededChildren = new Map<
      string,
      { parentId: string; name: string; dimension: RegulatoryDimension }
    >();
    for (const row of rows) {
      for (const key of nmraCategoryKeysForRow(row)) {
        const parentId = parentIdByName.get(key.parent)!;
        neededChildren.set(`${parentId}\0${key.name}`, {
          parentId,
          name: key.name,
          dimension: dimensionByParentName[key.parent],
        });
      }
    }

    const existingChildren = await this.prisma.productCategory.findMany({
      where: {
        tenantId,
        parentCategoryId: { in: [...parentIdByName.values()] },
      },
      select: { id: true, name: true, parentCategoryId: true },
    });
    const childIdByKey = new Map(
      existingChildren.map((c) => [`${c.parentCategoryId}\0${c.name}`, c.id]),
    );

    const missingChildren: Prisma.ProductCategoryCreateManyInput[] = [];
    for (const [key, child] of neededChildren) {
      if (childIdByKey.has(key)) continue;
      const id = randomUUID();
      childIdByKey.set(key, id);
      missingChildren.push({
        id,
        tenantId,
        name: child.name,
        parentCategoryId: child.parentId,
        dimension: child.dimension,
        source: "NMRA_IMPORT",
        isSystem: true,
      });
    }
    for (const chunk of chunkArray(missingChildren, RELATION_BATCH)) {
      await this.prisma.productCategory.createMany({ data: chunk, skipDuplicates: true });
    }

    const maps: Prisma.ProductCategoryMapCreateManyInput[] = [];
    const productIdsThisBatch = new Set<string>();
    for (const row of rows) {
      const product = byReg.get(row.registrationNo);
      if (!product) continue;
      productIdsThisBatch.add(product.id);
      for (const key of nmraCategoryKeysForRow(row)) {
        const parentId = parentIdByName.get(key.parent)!;
        const categoryId = childIdByKey.get(`${parentId}\0${key.name}`);
        if (!categoryId) continue;
        maps.push({
          id: randomUUID(),
          tenantId,
          productId: product.id,
          categoryId,
          dimension: dimensionByParentName[key.parent],
          isPrimary: true,
          assignmentSource: "NMRA_IMPORT",
        });
      }
    }

    let mapsAdded = 0;
    for (const chunk of chunkArray(maps, RELATION_BATCH)) {
      const res = await this.prisma.productCategoryMap.createMany({
        data: chunk,
        skipDuplicates: true,
      });
      mapsAdded += res.count;
    }

    // Every NMRA product should also carry a commercial (merchandising) classification.
    // Imports never overwrite an existing commercial mapping; products still missing one
    // land in the safe "Medicines → Unclassified Medicines" default — deterministic/AI
    // commercial classification can refine this later without touching NMRA-sourced data.
    await this.categoryTaxonomy.ensureCommercialTemplate(tenantId);
    await this.categoryTaxonomy.assignMissingPrimaryCommercial(
      tenantId,
      [...productIdsThisBatch],
      UNCLASSIFIED_MEDICINES_CANONICAL_KEY,
      "SYSTEM_DEFAULT",
    );
    // Tier 1 of the classification design: deterministic generic-name/dosage-form rules move
    // confident matches out of Unclassified Medicines; anything ambiguous stays there for review.
    await this.categoryTaxonomy.applyDeterministicMedicineClassification(tenantId);

    return mapsAdded;
  }

  private async ensureNmraTags(
    tenantId: string,
    rows: NmraProductRow[],
    byReg: Map<string, ExistingForNmraUpsert>,
  ): Promise<number> {
    const tagIdByName = new Map<string, string>();
    for (const t of NMRA_TAG_DEFS) {
      // Match on canonicalKey first: a tag created before the key existed is found by name and
      // adopted, so an existing tenant's tags are locked rather than duplicated.
      const existing =
        (await this.prisma.productTag.findFirst({
          where: { tenantId, canonicalKey: t.canonicalKey },
        })) ??
        (await this.prisma.productTag.findFirst({ where: { tenantId, name: t.name } }));
      if (existing) {
        if (!existing.isSystem || existing.canonicalKey !== t.canonicalKey) {
          await this.prisma.productTag.updateMany({
            where: { id: existing.id, tenantId },
            data: { isSystem: true, canonicalKey: t.canonicalKey },
          });
        }
        tagIdByName.set(t.name, existing.id);
      } else {
        const created = await this.prisma.productTag.create({
          data: { tenantId, name: t.name, canonicalKey: t.canonicalKey, isSystem: true },
        });
        tagIdByName.set(t.name, created.id);
      }
    }

    const maps: Prisma.ProductTagMapCreateManyInput[] = [];
    for (const row of rows) {
      const product = byReg.get(row.registrationNo);
      if (!product) continue;
      for (const t of NMRA_TAG_DEFS) {
        if (!t.pred(row)) continue;
        maps.push({
          id: randomUUID(),
          tenantId,
          productId: product.id,
          tagId: tagIdByName.get(t.name)!,
        });
      }
    }

    let touched = 0;
    for (const chunk of chunkArray(maps, RELATION_BATCH)) {
      const res = await this.prisma.productTagMap.createMany({
        data: chunk,
        skipDuplicates: true,
      });
      touched += res.count;
    }
    return touched;
  }

  private async ensureAliases(
    tenantId: string,
    rows: NmraProductRow[],
    byReg: Map<string, ExistingForNmraUpsert>,
  ) {
    const aliases: Prisma.ProductAliasCreateManyInput[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.registrationNo)) continue;
      seen.add(row.registrationNo);
      const product = byReg.get(row.registrationNo);
      if (!product) continue;
      for (const draft of nmraAliasDraftsForRow(row)) {
        aliases.push({
          tenantId,
          productId: product.id,
          aliasText: draft.aliasText,
          aliasType: draft.aliasType,
        });
      }
    }
    for (const chunk of chunkArray(aliases, RELATION_BATCH)) {
      await this.prisma.productAlias.createMany({ data: chunk, skipDuplicates: true });
    }
  }

  /**
   * Bulk barcode CSV: columns registrationNo|productId|sku + barcode.
   * Upserts product.barcode and a barcode alias.
   */
  async importBarcodes(
    tenantId: string,
    userId: string,
    file: Express.Multer.File,
  ): Promise<{
    updated: number;
    skipped: number;
    errors: Array<{ line: number; message: string }>;
  }> {
    if (!file?.buffer?.length) {
      throw new BadRequestException("Upload a CSV with registrationNo (or product id/sku) and barcode columns.");
    }
    const text = file.buffer.toString("utf8");
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) {
      throw new BadRequestException("CSV must include a header row and at least one data row.");
    }
    const header = lines[0]!.split(",").map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ""));
    const regIdx = header.findIndex((h) =>
      /^(registrationno|registration_no|reg\.?no\.?|regno)$/.test(h),
    );
    const idIdx = header.findIndex((h) => /^(productid|product_id|id)$/.test(h));
    const skuIdx = header.findIndex((h) => h === "sku");
    const bcIdx = header.findIndex((h) => /^(barcode|ean|gtin|upc)$/.test(h));
    if (bcIdx < 0 || (regIdx < 0 && idIdx < 0 && skuIdx < 0)) {
      throw new BadRequestException(
        "CSV needs a barcode column and one of: registrationNo, productId, or sku.",
      );
    }

    let updated = 0;
    let skipped = 0;
    const errors: Array<{ line: number; message: string }> = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i]!.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
      const barcode = cols[bcIdx]?.replace(/\s+/g, "");
      if (!barcode) {
        skipped += 1;
        continue;
      }
      try {
        let product:
          | { id: string; barcode: string | null }
          | null = null;
        if (idIdx >= 0 && cols[idIdx]) {
          product = await this.prisma.product.findFirst({
            where: { tenantId, id: cols[idIdx] },
            select: { id: true, barcode: true },
          });
        } else if (regIdx >= 0 && cols[regIdx]) {
          product = await this.prisma.product.findFirst({
            where: { tenantId, registrationNo: cols[regIdx] },
            select: { id: true, barcode: true },
          });
        } else if (skuIdx >= 0 && cols[skuIdx]) {
          product = await this.prisma.product.findFirst({
            where: { tenantId, sku: cols[skuIdx] },
            select: { id: true, barcode: true },
          });
        }
        if (!product) {
          errors.push({ line: i + 1, message: "Product not found" });
          continue;
        }
        if (product.barcode === barcode) {
          skipped += 1;
          continue;
        }
        await this.prisma.product.update({
          where: { id: product.id, tenantId },
          data: { barcode },
        });
        await this.prisma.productAlias.createMany({
          data: [
            {
              tenantId,
              productId: product.id,
              aliasText: barcode,
              aliasType: "barcode",
            },
          ],
          skipDuplicates: true,
        });
        updated += 1;
      } catch (err) {
        errors.push({
          line: i + 1,
          message: err instanceof Error ? err.message : "Update failed",
        });
      }
    }

    await this.audit.log({
      tenantId,
      actorUserId: userId,
      eventName: "products.barcode_import",
      entityName: "product",
      entityId: tenantId,
      payload: { updated, skipped, errorCount: errors.length },
    });

    return { updated, skipped, errors };
  }
}
