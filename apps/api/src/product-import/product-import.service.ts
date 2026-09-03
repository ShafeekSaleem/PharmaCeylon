import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Prisma, StockMovementType } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { IDEMPOTENCY_SCOPE } from "../common/idempotency.constants";
import { normalizeIdempotencyKey } from "../common/idempotency.util";
import {
  CatalogIndex,
  needsComplianceConfirmation,
  type MatchCandidate,
  type MatchOutcome,
} from "./product-import-match";
import {
  MAX_IMPORT_ROWS,
  parseExpiry,
  parseMoney,
  parseQty,
  parseSheet,
  suggestMapping,
  unmappedHeaders,
} from "./product-import-parse";
import {
  createImportJob,
  getImportJob,
  patchImportJob,
  toImportJobProgress,
  type ImportJobProgress,
} from "./product-import-jobs";
import {
  STOCK_FIELDS,
  type ImportAnalysis,
  type ImportField,
  type ImportMapping,
  type ImportPreview,
  type ImportResult,
  type ImportRowIssue,
  type ImportSummary,
  type MatchConfidence,
  type PendingComplianceMatch,
} from "./product-import.types";

/**
 * Placeholder expiry for stock imported without one. Far enough out that FEFO always picks a
 * real batch first, and paired with `Batch.needsExpiryReview` so the date is never mistaken
 * for something a person entered.
 */
const EXPIRY_PLACEHOLDER = new Date(Date.UTC(2099, 11, 31));

/** Product write batch size — sequential batches, never Promise.all on one pg client. */
const PRODUCT_BATCH = 100;

const MAX_ISSUES_KEPT = 500;

type ResolvedRow = {
  rowNumber: number;
  name: string;
  sku: string | null;
  barcode: string | null;
  brandName: string | null;
  genericName: string | null;
  manufacturer: string | null;
  dosageForm: string | null;
  strength: string | null;
  unit: string | null;
  packSize: string | null;
  registrationNo: string | null;
  categoryName: string | null;
  reorderLevel: number | null;
  qty: number | null;
  costPrice: number | null;
  sellingPrice: number | null;
  batchNo: string | null;
  expiryDate: Date | null;
  missingExpiry: boolean;
};

type PlannedRow = {
  row: ResolvedRow;
  match: MatchOutcome | null;
  /** Held back pending the user's confirmation of a compliance-setting fuzzy match. */
  held: boolean;
};

type Plan = {
  planned: PlannedRow[];
  issues: ImportRowIssue[];
  pendingCompliance: PendingComplianceMatch[];
  matchCounts: Record<MatchConfidence, number>;
  skipped: number;
};

@Injectable()
export class ProductImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ── Step 1: read the file, propose a mapping ────────────────────────────

  analyze(file: Express.Multer.File): ImportAnalysis {
    const { headers, rows } = this.readFile(file);
    if (headers.length === 0) {
      throw new BadRequestException("No column headers found in the file.");
    }
    const suggestedMapping = suggestMapping(headers);
    return {
      headers,
      totalRows: rows.length,
      sampleRows: rows.slice(0, 5),
      suggestedMapping,
      unmappedHeaders: unmappedHeaders(headers, suggestedMapping),
    };
  }

  // ── Step 2: dry run ─────────────────────────────────────────────────────

  async preview(
    tenantId: string,
    file: Express.Multer.File,
    mapping: ImportMapping,
  ): Promise<ImportPreview> {
    const { rows } = this.readFile(file);
    this.assertMapping(mapping);
    const resolved = this.resolveRows(rows, mapping);
    const index = await this.buildIndex(tenantId);
    const plan = this.planRows(resolved.rows, index, new Set());

    let create = 0;
    let update = 0;
    let withStock = 0;
    let unitsToPost = 0;
    let missingExpiry = 0;
    const sampleCreates: ImportPreview["sampleCreates"] = [];
    const sampleMatches: ImportPreview["sampleMatches"] = [];

    for (const item of plan.planned) {
      if (item.held) continue;
      if (item.match) {
        update += 1;
        if (sampleMatches.length < 8) {
          sampleMatches.push({
            rowNumber: item.row.rowNumber,
            name: item.row.name,
            matchedName: item.match.candidate.name,
            confidence: item.match.confidence,
          });
        }
      } else {
        create += 1;
        if (sampleCreates.length < 8) {
          sampleCreates.push({
            rowNumber: item.row.rowNumber,
            name: item.row.name,
            barcode: item.row.barcode,
          });
        }
      }
      if (item.row.qty != null && item.row.qty > 0) {
        withStock += 1;
        unitsToPost += item.row.qty;
        if (item.row.missingExpiry) missingExpiry += 1;
      }
    }

    return {
      totalRows: resolved.rows.length + resolved.issues.length,
      create,
      update,
      skip: plan.skipped + plan.pendingCompliance.length + resolved.issues.length,
      withStock,
      unitsToPost,
      missingExpiry,
      matchCounts: plan.matchCounts,
      issues: [...resolved.issues, ...plan.issues].slice(0, MAX_ISSUES_KEPT),
      pendingCompliance: plan.pendingCompliance,
      sampleCreates,
      sampleMatches,
      hasStockColumns: STOCK_FIELDS.some((f) => Boolean(mapping[f])),
    };
  }

  // ── Step 3: run it ──────────────────────────────────────────────────────

  /**
   * Validate and start the import. Parsing happens before the response so a bad file fails
   * fast, then the row work runs as a background job with progress polling — a 2,000-row file
   * with stock is thousands of writes and has no business holding an HTTP request open.
   */
  async startImport(
    tenantId: string,
    userId: string,
    branchId: string | undefined,
    file: Express.Multer.File,
    mapping: ImportMapping,
    confirmedRows: number[],
    idempotencyKeyRaw: string | undefined,
  ): Promise<{ jobId: string; importId: string }> {
    const idemKey = normalizeIdempotencyKey(idempotencyKeyRaw);
    if (idemKey) {
      const existing = await this.prisma.idempotencyRecord.findUnique({
        where: {
          tenantId_userId_scope_idempotencyKey: {
            tenantId,
            userId,
            scope: IDEMPOTENCY_SCOPE.productImport,
            idempotencyKey: idemKey,
          },
        },
      });
      if (existing) {
        const replay = await this.prisma.productImport.findFirst({
          where: { id: existing.resourceId, tenantId },
          select: { id: true },
        });
        if (!replay) {
          throw new BadRequestException(
            "Idempotency-Key is already recorded but the import could not be replayed",
          );
        }
        // A retried upload must never post the same opening stock twice.
        return { jobId: replay.id, importId: replay.id };
      }
    }

    const { rows } = this.readFile(file);
    this.assertMapping(mapping);
    const resolved = this.resolveRows(rows, mapping);
    if (resolved.rows.length === 0) {
      throw new BadRequestException(
        "No usable rows found. Check the column mapping — at minimum a product name column is required.",
      );
    }

    const hasStock = STOCK_FIELDS.some((f) => Boolean(mapping[f]));
    if (hasStock && !branchId) {
      throw new BadRequestException(
        "Select a branch before importing opening stock — stock is always held at a branch.",
      );
    }

    const importRecord = await this.prisma.productImport.create({
      data: {
        tenantId,
        branchId: hasStock ? branchId! : null,
        createdBy: userId,
        filename: file.originalname || "upload",
        mapping: mapping as Prisma.InputJsonValue,
      },
      select: { id: true },
    });

    if (idemKey) {
      await this.prisma.idempotencyRecord.create({
        data: {
          tenantId,
          userId,
          scope: IDEMPOTENCY_SCOPE.productImport,
          idempotencyKey: idemKey,
          resourceId: importRecord.id,
        },
      });
    }

    const jobId = importRecord.id;
    createImportJob(jobId, tenantId, importRecord.id);
    void this.runImport(
      jobId,
      tenantId,
      userId,
      hasStock ? branchId! : null,
      importRecord.id,
      resolved,
      new Set(confirmedRows),
    );
    return { jobId, importId: importRecord.id };
  }

  getJobProgress(tenantId: string, jobId: string): ImportJobProgress {
    const job = getImportJob(jobId);
    if (!job || job.tenantId !== tenantId) {
      throw new NotFoundException("Import job not found.");
    }
    return toImportJobProgress(job);
  }

  private async runImport(
    jobId: string,
    tenantId: string,
    userId: string,
    branchId: string | null,
    importId: string,
    resolved: { rows: ResolvedRow[]; issues: ImportRowIssue[] },
    confirmedRows: Set<number>,
  ): Promise<void> {
    patchImportJob(jobId, { status: "running", phase: "matching" });
    try {
      const index = await this.buildIndex(tenantId);
      const plan = this.planRows(resolved.rows, index, confirmedRows);
      const issues = [...resolved.issues, ...plan.issues];

      const toRun = plan.planned.filter((p) => !p.held);
      const total = toRun.length + (branchId ? toRun.length : 0);
      patchImportJob(jobId, { phase: "products", total, processed: 0 });

      const written = await this.writeProducts(
        tenantId,
        importId,
        toRun,
        issues,
        (processed, created, updated) =>
          patchImportJob(jobId, {
            phase: "products",
            processed,
            total,
            productsCreated: created,
            productsUpdated: updated,
            errorCount: issues.length,
          }),
      );

      let batchesCreated = 0;
      let unitsPosted = 0;
      let expiryReviewCount = 0;
      if (branchId) {
        patchImportJob(jobId, { phase: "stock" });
        const stock = await this.postOpeningStock(
          tenantId,
          branchId,
          userId,
          importId,
          toRun,
          written.productIdByRow,
          issues,
          (processed) =>
            patchImportJob(jobId, {
              phase: "stock",
              processed: written.processed + processed,
              total,
              batchesCreated,
              errorCount: issues.length,
            }),
        );
        batchesCreated = stock.batchesCreated;
        unitsPosted = stock.unitsPosted;
        expiryReviewCount = stock.expiryReviewCount;
      }

      const heldIssues: ImportRowIssue[] = plan.pendingCompliance.map((p) => ({
        rowNumber: p.rowNumber,
        name: p.name,
        message: `Held for review — matching "${p.matchedName}" would mark this ${
          p.wouldSetControlled ? "a controlled medicine" : "prescription-only"
        }. Confirm the match, or import this row separately.`,
      }));
      const allIssues = [...issues, ...heldIssues].slice(0, MAX_ISSUES_KEPT);

      const result: ImportResult = {
        importId,
        parsed: resolved.rows.length,
        productsCreated: written.created,
        productsUpdated: written.updated,
        productsRanged: written.ranged,
        batchesCreated,
        unitsPosted,
        rowsFailed: allIssues.length,
        expiryReviewCount,
        issues: allIssues,
      };

      await this.prisma.productImport.updateMany({
        where: { id: importId, tenantId },
        data: {
          status: "completed",
          productsCreated: result.productsCreated,
          productsUpdated: result.productsUpdated,
          productsRanged: result.productsRanged,
          batchesCreated,
          unitsPosted,
          rowsFailed: result.rowsFailed,
          expiryReviewCount,
          errorReport: allIssues as unknown as Prisma.InputJsonValue,
          completedAt: new Date(),
        },
      });

      await this.audit.log({
        tenantId,
        branchId,
        actorUserId: userId,
        eventName: "products.import_completed",
        entityName: "product_import",
        entityId: importId,
        payload: {
          productsCreated: result.productsCreated,
          productsUpdated: result.productsUpdated,
          productsRanged: result.productsRanged,
          batchesCreated,
          unitsPosted,
          rowsFailed: result.rowsFailed,
          expiryReviewCount,
        },
      });

      patchImportJob(jobId, {
        status: "completed",
        phase: "done",
        processed: total,
        total,
        productsCreated: result.productsCreated,
        productsUpdated: result.productsUpdated,
        batchesCreated,
        errorCount: result.rowsFailed,
        result,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Import failed";
      await this.prisma.productImport
        .updateMany({
          where: { id: importId, tenantId },
          data: { status: "failed", error: message, completedAt: new Date() },
        })
        .catch(() => undefined);
      patchImportJob(jobId, { status: "failed", phase: "failed", error: message });
    }
  }

  // ── Undo ────────────────────────────────────────────────────────────────

  async listImports(tenantId: string, take = 10): Promise<ImportSummary[]> {
    const rows = await this.prisma.productImport.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: Math.min(take, 50),
      include: { actor: { select: { fullName: true } } },
    });

    return Promise.all(
      rows.map(async (r) => {
        const blocked =
          r.status !== "completed"
            ? r.status === "undone"
              ? "This import has already been undone."
              : "Only a completed import can be undone."
            : await this.undoBlockedReason(tenantId, r.id);
        return {
          id: r.id,
          filename: r.filename,
          status: r.status,
          branchId: r.branchId,
          createdAt: r.createdAt.toISOString(),
          completedAt: r.completedAt?.toISOString() ?? null,
          undoneAt: r.undoneAt?.toISOString() ?? null,
          productsCreated: r.productsCreated,
          productsUpdated: r.productsUpdated,
          productsRanged: r.productsRanged,
          batchesCreated: r.batchesCreated,
          unitsPosted: r.unitsPosted,
          rowsFailed: r.rowsFailed,
          expiryReviewCount: r.expiryReviewCount,
          actorName: r.actor?.fullName ?? null,
          canUndo: blocked === null,
          undoBlockedReason: blocked,
        };
      }),
    );
  }

  /**
   * Undo is only offered while the import is still untouched — the moment stock has moved for
   * any other reason, reversing it would be rewriting history rather than cancelling a mistake.
   */
  private async undoBlockedReason(
    tenantId: string,
    importId: string,
  ): Promise<string | null> {
    const batchIds = await this.importBatchIds(tenantId, importId);
    if (batchIds.length > 0) {
      const otherMovement = await this.prisma.stockLedger.findFirst({
        where: {
          tenantId,
          batchId: { in: batchIds },
          NOT: { referenceType: "product_import", referenceId: importId },
        },
        select: { id: true },
      });
      if (otherMovement) {
        return "Stock from this import has already been sold or moved.";
      }
    }

    const tradedProduct = await this.prisma.product.findFirst({
      where: {
        tenantId,
        importId,
        OR: [
          { saleItems: { some: {} } },
          { purchaseItems: { some: {} } },
          { receiptItems: { some: {} } },
          { transferItems: { some: {} } },
          { returnItems: { some: {} } },
        ],
      },
      select: { id: true },
    });
    if (tradedProduct) {
      return "Products from this import have already been sold, ordered or transferred.";
    }
    return null;
  }

  private async importBatchIds(tenantId: string, importId: string): Promise<string[]> {
    const rows = await this.prisma.stockLedger.findMany({
      where: { tenantId, referenceType: "product_import", referenceId: importId },
      select: { batchId: true },
      distinct: ["batchId"],
    });
    return rows.map((r) => r.batchId).filter((id): id is string => Boolean(id));
  }

  async undo(tenantId: string, userId: string, importId: string) {
    const record = await this.prisma.productImport.findFirst({
      where: { id: importId, tenantId },
    });
    if (!record) throw new NotFoundException("Import not found.");
    if (record.status === "undone") {
      throw new ConflictException("This import has already been undone.");
    }
    if (record.status !== "completed") {
      throw new ConflictException("Only a completed import can be undone.");
    }

    const blocked = await this.undoBlockedReason(tenantId, importId);
    if (blocked) throw new ConflictException(blocked);

    const batchIds = await this.importBatchIds(tenantId, importId);

    const removed = await this.prisma.$transaction(
      async (tx) => {
        await tx.stockLedger.deleteMany({
          where: { tenantId, referenceType: "product_import", referenceId: importId },
        });
        const batches =
          batchIds.length > 0
            ? await tx.batch.deleteMany({ where: { tenantId, id: { in: batchIds } } })
            : { count: 0 };

        // Products the import only matched and updated are left alone: the import didn't
        // create them, and there is no before-image to restore them to.
        const products = await tx.product.deleteMany({
          where: { tenantId, importId },
        });

        await tx.productImport.updateMany({
          where: { id: importId, tenantId },
          data: { status: "undone", undoneAt: new Date() },
        });

        return { batches: batches.count, products: products.count };
      },
      { timeout: 120_000, maxWait: 60_000 },
    );

    await this.audit.log({
      tenantId,
      branchId: record.branchId,
      actorUserId: userId,
      eventName: "products.import_undone",
      entityName: "product_import",
      entityId: importId,
      payload: {
        batchesRemoved: removed.batches,
        productsRemoved: removed.products,
        productsLeftInPlace: record.productsUpdated,
      },
    });

    return {
      ok: true,
      batchesRemoved: removed.batches,
      productsRemoved: removed.products,
      productsLeftInPlace: record.productsUpdated,
    };
  }

  async errorReport(tenantId: string, importId: string): Promise<string> {
    const record = await this.prisma.productImport.findFirst({
      where: { id: importId, tenantId },
      select: { errorReport: true },
    });
    if (!record) throw new NotFoundException("Import not found.");
    const issues = Array.isArray(record.errorReport)
      ? (record.errorReport as unknown as ImportRowIssue[])
      : [];
    const lines = ["Row,Product,Problem"];
    for (const issue of issues) {
      lines.push(
        [issue.rowNumber, issue.name, issue.message].map(escapeCsv).join(","),
      );
    }
    return lines.join("\n");
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private readFile(file: Express.Multer.File) {
    if (!file?.buffer?.length) {
      throw new BadRequestException("Upload a CSV or Excel file.");
    }
    const name = (file.originalname ?? "").toLowerCase();
    if (name && !/\.(xlsx?|csv)$/.test(name)) {
      const okMime = /sheet|excel|csv|octet-stream/i.test(file.mimetype ?? "");
      if (!okMime) {
        throw new BadRequestException(
          "Unsupported file type. Upload a .csv, .xls or .xlsx export.",
        );
      }
    }
    let parsed;
    try {
      parsed = parseSheet(file.buffer, file.originalname);
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : "Failed to read the file",
      );
    }
    if (parsed.rows.length > MAX_IMPORT_ROWS) {
      throw new BadRequestException(
        `This file has ${parsed.rows.length.toLocaleString()} rows, above the limit of ${MAX_IMPORT_ROWS.toLocaleString()}. Split it and import in parts.`,
      );
    }
    return parsed;
  }

  private assertMapping(mapping: ImportMapping): void {
    if (!mapping?.name) {
      throw new BadRequestException(
        "Map a column to Product name — it is the one field every row needs.",
      );
    }
  }

  /** File rows → typed rows, collecting per-row problems rather than failing the whole file. */
  private resolveRows(
    rows: Array<Record<string, string>>,
    mapping: ImportMapping,
  ): { rows: ResolvedRow[]; issues: ImportRowIssue[] } {
    const out: ResolvedRow[] = [];
    const issues: ImportRowIssue[] = [];
    const cell = (row: Record<string, string>, field: ImportField): string => {
      const header = mapping[field];
      if (!header) return "";
      return row[header] ?? "";
    };

    rows.forEach((raw, i) => {
      // +2: one for the header row, one because spreadsheet rows are 1-based.
      const rowNumber = i + 2;
      const name = cell(raw, "name").trim();
      if (!name) {
        issues.push({ rowNumber, name: "", message: "No product name in this row." });
        return;
      }

      const qtyText = cell(raw, "qty");
      const qty = parseQty(qtyText);
      if (qtyText && qty == null) {
        issues.push({ rowNumber, name, message: `Quantity "${qtyText}" isn't a number.` });
        return;
      }
      if (qty != null && qty < 0) {
        issues.push({ rowNumber, name, message: "Quantity can't be negative." });
        return;
      }

      const costText = cell(raw, "costPrice");
      const cost = parseMoney(costText);
      if (costText && cost == null) {
        issues.push({ rowNumber, name, message: `Cost "${costText}" isn't a valid amount.` });
        return;
      }
      const priceText = cell(raw, "sellingPrice");
      const price = parseMoney(priceText);
      if (priceText && price == null) {
        issues.push({ rowNumber, name, message: `Price "${priceText}" isn't a valid amount.` });
        return;
      }

      const expiryText = cell(raw, "expiryDate");
      const expiry = parseExpiry(expiryText);
      if (expiryText && !expiry) {
        issues.push({
          rowNumber,
          name,
          message: `Expiry "${expiryText}" isn't a date we recognise. Use YYYY-MM-DD, DD/MM/YYYY, or MM/YYYY.`,
        });
        return;
      }

      if (qty != null && qty > 0 && price == null) {
        issues.push({
          rowNumber,
          name,
          message: "This row has stock but no selling price — a batch can't be priced without one.",
        });
        return;
      }

      out.push({
        rowNumber,
        name,
        sku: cell(raw, "sku").trim() || null,
        barcode: cell(raw, "barcode").replace(/\s+/g, "") || null,
        brandName: cell(raw, "brandName").trim() || null,
        genericName: cell(raw, "genericName").trim() || null,
        manufacturer: cell(raw, "manufacturer").trim() || null,
        dosageForm: cell(raw, "dosageForm").trim() || null,
        strength: cell(raw, "strength").trim() || null,
        unit: cell(raw, "unit").trim() || null,
        packSize: cell(raw, "packSize").trim() || null,
        registrationNo: cell(raw, "registrationNo").trim() || null,
        categoryName: cell(raw, "categoryName").trim() || null,
        reorderLevel: parseQty(cell(raw, "reorderLevel")),
        qty,
        costPrice: cost,
        sellingPrice: price,
        batchNo: cell(raw, "batchNo").trim() || null,
        expiryDate: expiry,
        missingExpiry: qty != null && qty > 0 && !expiry,
      });
    });

    return { rows: out, issues };
  }

  private async buildIndex(tenantId: string): Promise<CatalogIndex> {
    const candidates = await this.prisma.product.findMany({
      where: { tenantId },
      select: {
        id: true,
        name: true,
        barcode: true,
        registrationNo: true,
        genericName: true,
        strength: true,
        dosageForm: true,
        isControlled: true,
        requiresPrescription: true,
      },
    });
    return new CatalogIndex(candidates as MatchCandidate[]);
  }

  /**
   * Decide what happens to each row: link to an existing product, create a new one, or hold it
   * for review. Rows that repeat a barcode or name already used earlier in the same file are
   * skipped rather than fighting each other for the same product.
   */
  private planRows(
    rows: ResolvedRow[],
    index: CatalogIndex,
    confirmedRows: Set<number>,
  ): Plan {
    const planned: PlannedRow[] = [];
    const issues: ImportRowIssue[] = [];
    const pendingCompliance: PendingComplianceMatch[] = [];
    const matchCounts: Record<MatchConfidence, number> = {
      barcode: 0,
      registration: 0,
      name: 0,
      normalized: 0,
      fuzzy: 0,
    };
    const seenBarcodes = new Set<string>();
    const seenNames = new Set<string>();
    const claimedProductIds = new Set<string>();
    let skipped = 0;

    for (const row of rows) {
      const barcodeKey = row.barcode?.toLowerCase();
      const nameKey = row.name.trim().toLowerCase();
      if (barcodeKey && seenBarcodes.has(barcodeKey)) {
        issues.push({
          rowNumber: row.rowNumber,
          name: row.name,
          message: `Barcode ${row.barcode} already appears earlier in this file.`,
        });
        skipped += 1;
        continue;
      }
      if (!barcodeKey && seenNames.has(nameKey)) {
        issues.push({
          rowNumber: row.rowNumber,
          name: row.name,
          message: "This product name already appears earlier in this file.",
        });
        skipped += 1;
        continue;
      }

      let match = index.match(row);
      // Two rows must never both claim the same existing product — the second would silently
      // overwrite the first's prices and stock.
      if (match && claimedProductIds.has(match.candidate.id)) {
        issues.push({
          rowNumber: row.rowNumber,
          name: row.name,
          message: `Matches "${match.candidate.name}", which an earlier row in this file already matched.`,
        });
        skipped += 1;
        continue;
      }

      let held = false;
      if (match && needsComplianceConfirmation(match) && !confirmedRows.has(row.rowNumber)) {
        pendingCompliance.push({
          rowNumber: row.rowNumber,
          name: row.name,
          matchedProductId: match.candidate.id,
          matchedName: match.candidate.name,
          matchedRegistrationNo: match.candidate.registrationNo,
          wouldSetControlled: match.candidate.isControlled,
          wouldSetPrescription: match.candidate.requiresPrescription,
        });
        held = true;
        match = null;
      }

      if (barcodeKey) seenBarcodes.add(barcodeKey);
      seenNames.add(nameKey);
      if (match) {
        claimedProductIds.add(match.candidate.id);
        matchCounts[match.confidence] += 1;
      }
      planned.push({ row, match, held });
    }

    return { planned, issues, pendingCompliance, matchCounts, skipped };
  }

  private async writeProducts(
    tenantId: string,
    importId: string,
    planned: PlannedRow[],
    issues: ImportRowIssue[],
    onProgress: (processed: number, created: number, updated: number) => void,
  ): Promise<{
    created: number;
    updated: number;
    ranged: number;
    processed: number;
    productIdByRow: Map<number, string>;
  }> {
    const productIdByRow = new Map<number, string>();
    let created = 0;
    let updated = 0;
    let ranged = 0;
    let processed = 0;

    const usedSkus = new Set(
      (
        await this.prisma.product.findMany({
          where: { tenantId },
          select: { sku: true },
        })
      ).map((p) => p.sku),
    );

    for (let i = 0; i < planned.length; i += PRODUCT_BATCH) {
      const chunk = planned.slice(i, i + PRODUCT_BATCH);
      await this.prisma.$transaction(
        async (tx) => {
          for (const item of chunk) {
            try {
              if (item.match) {
                const candidateId = item.match.candidate.id;
                const before = await tx.product.findFirst({
                  where: { id: candidateId, tenantId },
                  select: { rangeStatus: true },
                });
                await tx.product.updateMany({
                  where: { id: candidateId, tenantId },
                  data: {
                    // Only fill gaps: an existing catalog record's own data is better than a
                    // spreadsheet's, so the import never overwrites what is already there.
                    ...(item.row.barcode ? { barcode: item.row.barcode } : {}),
                    ...(item.row.brandName ? { brandName: item.row.brandName } : {}),
                    ...(item.row.packSize ? { packSize: item.row.packSize } : {}),
                    ...(item.row.reorderLevel != null
                      ? { reorderLevel: item.row.reorderLevel }
                      : {}),
                    // The pharmacy is telling us it sells this — that is the point of the file.
                    rangeStatus: "RANGED",
                    ...(before?.rangeStatus === "REFERENCE" ? { rangedAt: new Date() } : {}),
                  },
                });
                if (before?.rangeStatus === "REFERENCE") ranged += 1;
                productIdByRow.set(item.row.rowNumber, candidateId);
                updated += 1;
              } else {
                const sku = uniqueSku(item.row, usedSkus);
                const product = await tx.product.create({
                  data: {
                    tenantId,
                    sku,
                    name: item.row.name,
                    barcode: item.row.barcode,
                    brandName: item.row.brandName,
                    genericName: item.row.genericName,
                    manufacturer: item.row.manufacturer,
                    dosageForm: item.row.dosageForm,
                    strength: item.row.strength,
                    unit: item.row.unit,
                    packSize: item.row.packSize,
                    registrationNo: item.row.registrationNo,
                    reorderLevel: item.row.reorderLevel ?? 0,
                    // No registry match: a retail item until someone says otherwise. Compliance
                    // flags are never invented here — an unmatched row has no evidence for them.
                    source: "CSV_IMPORT",
                    rangeStatus: "RANGED",
                    rangedAt: new Date(),
                    importId,
                  },
                  select: { id: true },
                });
                productIdByRow.set(item.row.rowNumber, product.id);
                created += 1;
              }
            } catch (err) {
              issues.push({
                rowNumber: item.row.rowNumber,
                name: item.row.name,
                message: err instanceof Error ? err.message : "Could not save this product.",
              });
            }
          }
        },
        { timeout: 120_000, maxWait: 60_000 },
      );
      processed += chunk.length;
      onProgress(processed, created, updated);
    }

    return { created, updated, ranged, processed, productIdByRow };
  }

  private async postOpeningStock(
    tenantId: string,
    branchId: string,
    userId: string,
    importId: string,
    planned: PlannedRow[],
    productIdByRow: Map<number, string>,
    issues: ImportRowIssue[],
    onProgress: (processed: number) => void,
  ): Promise<{ batchesCreated: number; unitsPosted: number; expiryReviewCount: number }> {
    const withStock = planned.filter((p) => p.row.qty != null && p.row.qty > 0);
    let batchesCreated = 0;
    let unitsPosted = 0;
    let expiryReviewCount = 0;
    let processed = 0;

    for (let i = 0; i < withStock.length; i += PRODUCT_BATCH) {
      const chunk = withStock.slice(i, i + PRODUCT_BATCH);
      await this.prisma.$transaction(
        async (tx) => {
          for (const item of chunk) {
            const productId = productIdByRow.get(item.row.rowNumber);
            if (!productId) continue;
            try {
              const batchNo = item.row.batchNo?.trim() || "OPENING";
              const expiry = item.row.expiryDate ?? EXPIRY_PLACEHOLDER;
              const needsExpiryReview = item.row.expiryDate == null;

              const existing = await tx.batch.findFirst({
                where: { tenantId, branchId, productId, batchNo },
                select: { id: true },
              });
              if (existing) {
                issues.push({
                  rowNumber: item.row.rowNumber,
                  name: item.row.name,
                  message: `Batch "${batchNo}" already exists at this branch for this product — stock not posted.`,
                });
                continue;
              }

              const batch = await tx.batch.create({
                data: {
                  tenantId,
                  branchId,
                  productId,
                  batchNo,
                  expiryDate: expiry,
                  costPrice: new Prisma.Decimal(item.row.costPrice ?? 0),
                  sellingPrice: new Prisma.Decimal(item.row.sellingPrice ?? 0),
                  needsExpiryReview,
                },
                select: { id: true },
              });

              await tx.stockLedger.create({
                data: {
                  tenantId,
                  branchId,
                  productId,
                  batchId: batch.id,
                  movementType: StockMovementType.opening_stock,
                  qtyDelta: item.row.qty!,
                  // referenceId is what makes undo possible — it is how the ledger rows,
                  // and through them the batches, are traced back to this import.
                  referenceType: "product_import",
                  referenceId: importId,
                  reason: "Opening stock import",
                  createdBy: userId,
                },
              });

              batchesCreated += 1;
              unitsPosted += item.row.qty!;
              if (needsExpiryReview) expiryReviewCount += 1;
            } catch (err) {
              issues.push({
                rowNumber: item.row.rowNumber,
                name: item.row.name,
                message:
                  err instanceof Error ? err.message : "Could not post opening stock.",
              });
            }
          }
        },
        { timeout: 120_000, maxWait: 60_000 },
      );
      processed += chunk.length;
      onProgress(processed);
    }

    return { batchesCreated, unitsPosted, expiryReviewCount };
  }
}

/**
 * SKU from the file when it is free, otherwise a generated one. A customer export's own codes
 * are worth keeping — they are what the pharmacy's staff already recognise — but they collide
 * with existing products often enough that a fallback is required.
 */
function uniqueSku(row: ResolvedRow, used: Set<string>): string {
  const candidates = [row.sku, row.barcode, row.registrationNo].filter(
    (v): v is string => Boolean(v?.trim()),
  );
  for (const candidate of candidates) {
    const sku = candidate.trim().slice(0, 64);
    if (!used.has(sku)) {
      used.add(sku);
      return sku;
    }
  }
  let sku = `IMP-${randomUUID().slice(0, 8).toUpperCase()}`;
  while (used.has(sku)) sku = `IMP-${randomUUID().slice(0, 8).toUpperCase()}`;
  used.add(sku);
  return sku;
}

function escapeCsv(value: string | number | null | undefined): string {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
