/// <reference types="multer" />
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import {
  AuthenticatedRequest,
  RequestUser,
} from "../security/interfaces/authenticated-request.interface";
import { ProductImportService } from "./product-import.service";
import {
  IMPORT_FIELDS,
  type ImportCategoryChoices,
  type ImportField,
  type ImportMapping,
} from "./product-import.types";

const UPLOAD_LIMITS = { limits: { fileSize: 20 * 1024 * 1024 } };

/**
 * A pharmacy's own product list, with optional opening stock on the same rows.
 *
 * Three steps, because a customer's export has no fixed shape: `analyze` reads the headers and
 * proposes a mapping, `preview` dry-runs it, `confirm` starts a job. `confirm` accepts an
 * `Idempotency-Key` like every other stock-mutating endpoint, so a retried upload never posts
 * the same opening stock twice.
 */
@Controller("products/import")
export class ProductImportController {
  constructor(private readonly imports: ProductImportService) {}

  /** Blank CSV with the columns the importer understands, for a pharmacy starting from zero. */
  @RequirePermission("products.import")
  @Get("template")
  template(): StreamableFile {
    const header = [
      "Name",
      "Barcode",
      "Brand",
      "Generic name",
      "Manufacturer",
      "Dosage form",
      "Strength",
      "Unit",
      "Pack size",
      "Registration no.",
      "Category",
      "Reorder level",
      "Qty",
      "Cost price",
      "Selling price",
      "Batch no.",
      "Expiry date",
    ].join(",");
    const example = [
      "Panadol 500mg Tablet,4892345001234,Panadol,Paracetamol,GSK,Tablet,500mg,Tablet,10 x 10 tabs,,Pain & Fever,20,240,3.10,4.50,B24118,2027-04-30",
      "Sunsilk Shampoo 180ml,4800888123456,Sunsilk,,Unilever,,,Bottle,180 ml,,Personal Care,5,18,410.00,545.00,,",
    ].join("\n");
    const csv = `${header}\n${example}\n`;
    return new StreamableFile(Buffer.from(csv, "utf-8"), {
      type: "text/csv; charset=utf-8",
      disposition: 'attachment; filename="product-import-template.csv"',
    });
  }

  /**
   * Past imports, newest first. Deliberately NOT the bare `GET /products/import`: that is one
   * path segment under the `products` prefix, so `ProductsController`'s `@Get(":id")` claims it
   * first and the request dies on the UUID pipe.
   */
  @RequirePermission("products.import")
  @Get("history")
  list(@CurrentUser() user: RequestUser, @Query("take") take?: string) {
    return this.imports.listImports(
      user.tenantId,
      take ? Number(take) : undefined,
    );
  }

  @RequirePermission("products.import")
  @UseInterceptors(FileInterceptor("file", UPLOAD_LIMITS))
  @Post("analyze")
  analyze(@UploadedFile() file: Express.Multer.File) {
    return this.imports.analyze(file);
  }

  @RequirePermission("products.import")
  @UseInterceptors(FileInterceptor("file", UPLOAD_LIMITS))
  @Post("preview")
  preview(
    @CurrentUser() user: RequestUser,
    @UploadedFile() file: Express.Multer.File,
    @Body("mapping") mappingRaw?: string,
  ) {
    return this.imports.preview(user.tenantId, file, parseMapping(mappingRaw));
  }

  @RequirePermission("products.import")
  @UseInterceptors(FileInterceptor("file", UPLOAD_LIMITS))
  @Post("confirm")
  confirm(
    @CurrentUser() user: RequestUser,
    @Req() req: AuthenticatedRequest,
    @UploadedFile() file: Express.Multer.File,
    @Body("mapping") mappingRaw?: string,
    @Body("confirmedRows") confirmedRowsRaw?: string,
    @Body("categoryChoices") categoryChoicesRaw?: string,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return this.imports.startImport(
      user.tenantId,
      user.userId,
      req.branchId,
      file,
      parseMapping(mappingRaw),
      parseConfirmedRows(confirmedRowsRaw),
      parseCategoryChoices(categoryChoicesRaw),
      idempotencyKey,
    );
  }

  @RequirePermission("products.import")
  @Get("jobs/:jobId")
  jobProgress(
    @CurrentUser() user: RequestUser,
    @Param("jobId", ParseUUIDPipe) jobId: string,
  ) {
    return this.imports.getJobProgress(user.tenantId, jobId);
  }

  @RequirePermission("products.import")
  @Get(":importId/errors")
  async errors(
    @CurrentUser() user: RequestUser,
    @Param("importId", ParseUUIDPipe) importId: string,
  ): Promise<StreamableFile> {
    const csv = await this.imports.errorReport(user.tenantId, importId);
    return new StreamableFile(Buffer.from(csv, "utf-8"), {
      type: "text/csv; charset=utf-8",
      disposition: 'attachment; filename="import-errors.csv"',
    });
  }

  @RequirePermission("products.import")
  @Post(":importId/undo")
  undo(
    @CurrentUser() user: RequestUser,
    @Param("importId", ParseUUIDPipe) importId: string,
  ) {
    return this.imports.undo(user.tenantId, user.userId, importId);
  }
}

/**
 * The mapping rides along as a JSON string in the multipart body — the file has to be re-sent
 * on every step anyway, and multipart has no native nested objects.
 */
function parseMapping(raw: string | undefined): ImportMapping {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadRequestException("Column mapping is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BadRequestException("Column mapping must be an object.");
  }
  const allowed = new Set<string>(IMPORT_FIELDS);
  const mapping: ImportMapping = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!allowed.has(key)) continue;
    if (typeof value !== "string" || !value.trim()) continue;
    mapping[key as ImportField] = value;
  }
  return mapping;
}

/**
 * The Review step's category decisions, keyed by the incoming Category value. Rides along as
 * JSON in the multipart body for the same reason the mapping does. Anything malformed is
 * dropped rather than rejected — a bad key only costs that value its override, and the plan's
 * own resolution still applies.
 */
function parseCategoryChoices(raw: string | undefined): ImportCategoryChoices {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadRequestException("Category choices are not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BadRequestException("Category choices must be an object.");
  }

  const out: ImportCategoryChoices = {};
  for (const [incoming, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!incoming.trim() || typeof value !== "object" || value === null) continue;
    const decision = value as Record<string, unknown>;
    if (decision.action === "use" && typeof decision.categoryId === "string") {
      out[incoming] = { action: "use", categoryId: decision.categoryId };
    } else if (decision.action === "create") {
      const parent = decision.parentCategoryId;
      out[incoming] = {
        action: "create",
        parentCategoryId: typeof parent === "string" && parent ? parent : null,
      };
    } else if (decision.action === "skip") {
      out[incoming] = { action: "skip" };
    }
  }
  return out;
}

function parseConfirmedRows(raw: string | undefined): number[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadRequestException("Confirmed rows must be a JSON array of row numbers.");
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((v) => Number(v))
    .filter((v) => Number.isInteger(v) && v > 0)
    .slice(0, 20_000);
}
