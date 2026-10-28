import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, ProductImport, StockMovementType } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { tenantTransactionStorage } from "../prisma/tenant-transaction.store";
import { AuditService } from "../audit/audit.service";
import { StockService } from "../inventory/stock/stock.service";
import { AccessService } from "../security/access.service";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import type { CommandProvenance } from "../terminals/command-provenance";

export type StagedStockRow = {
  rowNumber: number;
  productId: string;
  name: string;
  categoryName: string | null;
  qty: number;
  costPrice: number;
  sellingPrice: number;
  batchNo: string;
  expiryDate: string | null;
  postedBatchId?: string;
};

/** Draft management and physical posting are separate transactional operations. The stock
 * route's local policy is enforced at the coordinated P1/P2 cutover, like held-stock posting.
 * This service does not accept client assertions of attendance or change rollout policy. */
@Injectable()
export class ImportStockService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
  ) {}

  async authorize(
    user: RequestUser,
    branchId: string,
    tx: Prisma.TransactionClient,
  ) {
    return this.requireAccess(user, branchId, tx);
  }

  async authorizeUndo(
    user: RequestUser,
    selectedBranchId: string | undefined,
    tx: Prisma.TransactionClient,
    importBranchId: string | null,
  ) {
    if (importBranchId || selectedBranchId)
      return this.requireAccess(user, importBranchId ?? selectedBranchId!, tx);
    const assignments = await tx.userBranchRole.findMany({
      where: { tenantId: user.tenantId, userId: user.userId },
      select: { branchId: true },
    });
    for (const { branchId } of assignments) {
      try {
        await this.requireAccess(user, branchId, tx);
        return;
      } catch (error) {
        if (!(error instanceof ForbiddenException)) throw error;
      }
    }
    throw new ForbiddenException("Current product import permission required.");
  }

  async read(user: RequestUser, branchId: string, importId: string) {
    return this.transaction(user, branchId, importId, async (tx, record) =>
      this.view(record, user, branchId, tx),
    );
  }

  async replace(
    user: RequestUser,
    branchId: string,
    importId: string,
    input: unknown,
  ) {
    const body = this.body(input, ["version", "rows"]);
    const version = this.version(body.version);
    const rows = parseStagedRows(body.rows);
    return this.transaction(user, branchId, importId, async (tx, record) => {
      this.checkVersion(record, version);
      if (
        !(await this.access.resolveLive(user, branchId, tx)).has("costs.view")
      )
        throw new ForbiddenException(
          "Cost access is required to replace stock costs.",
        );
      if (record.stockPostedAt)
        throw new ConflictException(
          "Stock is already posted. Correct it with a stock adjustment at the counter.",
        );
      const productIds = [...new Set(rows.map((row) => row.productId))];
      const found = await tx.product.count({
        where: { tenantId: user.tenantId, id: { in: productIds } },
      });
      if (found !== productIds.length)
        throw new BadRequestException(
          "A staged product is unavailable in this tenant.",
        );
      await this.requireAccess(user, branchId, tx);
      if (
        !(await this.access.resolveLive(user, branchId, tx)).has("costs.view")
      )
        throw new ForbiddenException(
          "Cost access is required to replace stock costs.",
        );
      const next = await tx.productImport.update({
        where: { id: record.id, tenantId: user.tenantId },
        data: {
          stagedStock: rows as unknown as Prisma.InputJsonValue,
          stockStagedBy: user.userId,
        },
      });
      await this.audit.log(
        {
          tenantId: user.tenantId,
          branchId,
          actorUserId: user.userId,
          eventName: "products.import_stock_replaced",
          entityName: "product_import",
          entityId: importId,
          payload: {
            previousVersion: version,
            version: next.stockVersion,
            rows: rows.length,
            stagedBy: user.userId,
          },
        },
        tx,
      );
      return this.view(next, user, branchId, tx);
    });
  }

  async post(
    user: RequestUser,
    branchId: string,
    importId: string,
    input: unknown,
  ) {
    return (
      await this.prisma.$transaction(
        (tx) => this.postInTransaction(tx, user, branchId, importId, input),
        { timeout: 120_000, maxWait: 60_000 },
      )
    ).view;
  }

  /** Posting core shared by the browser route and the signed terminal executor, in the caller's
   * READ COMMITTED transaction. `command` is verified provenance copied into the success audit.
   */
  async postInTransaction(
    tx: Prisma.TransactionClient,
    user: RequestUser,
    branchId: string,
    importId: string,
    input: unknown,
    command?: CommandProvenance,
  ) {
    const body = this.body(input, ["version", "categoryName"]);
    const version = this.version(body.version);
    if (
      body.categoryName !== undefined &&
      body.categoryName !== null &&
      (typeof body.categoryName !== "string" || !body.categoryName.trim())
    ) {
      throw new BadRequestException(
        "Choose a staged category or post the whole draft.",
      );
    }
    return this.locked(tx, user, branchId, importId, async (tx, record) => {
      this.checkVersion(record, version);
      const rows = record.stagedStock as unknown as StagedStockRow[];
      const selected = rows.filter(
        (row) =>
          body.categoryName === undefined ||
          row.categoryName === body.categoryName,
      );
      if (!selected.length)
        throw new BadRequestException("No stock rows in this selection.");
      const pending = selected.filter((row) => !row.postedBatchId);
      // Same immutable version/selection replays saved batch IDs after response loss.
      if (!pending.length)
        return {
          view: await this.view(record, user, branchId, tx),
          batchesPosted: 0,
          unitsPosted: 0,
        };
      const lines = [];
      for (const row of pending) {
        const product = await tx.product.findFirst({
          where: { id: row.productId, tenantId: user.tenantId },
          select: { id: true },
        });
        if (!product)
          throw new ConflictException(
            "A staged product is no longer available.",
          );
        const existing = await tx.batch.findFirst({
          where: {
            tenantId: user.tenantId,
            branchId,
            productId: row.productId,
            batchNo: row.batchNo,
          },
          select: { id: true },
        });
        if (existing)
          throw new ConflictException(
            `Batch "${row.batchNo}" already exists. Review the staged draft before posting.`,
          );
        const batch = await tx.batch.create({
          data: {
            tenantId: user.tenantId,
            branchId,
            productId: row.productId,
            batchNo: row.batchNo,
            expiryDate: row.expiryDate
              ? new Date(row.expiryDate)
              : new Date("2099-12-31T00:00:00Z"),
            needsExpiryReview: !row.expiryDate,
            costPrice: new Prisma.Decimal(row.costPrice),
            sellingPrice: new Prisma.Decimal(row.sellingPrice),
          },
          select: { id: true },
        });
        row.postedBatchId = batch.id;
        lines.push({
          productId: row.productId,
          batchId: batch.id,
          qty: row.qty,
          movementType: StockMovementType.opening_stock,
          reason: "Staged opening stock import",
        });
      }
      await this.stock.receive(
        tx,
        {
          tenantId: user.tenantId,
          branchId,
          userId: user.userId,
          referenceType: "product_import",
          referenceId: importId,
        },
        lines,
      );
      // Stock locks may have waited. Re-read current executor authority before committing.
      await this.requireAccess(user, branchId, tx);
      const next = await tx.productImport.update({
        where: { id: record.id, tenantId: user.tenantId },
        data: {
          stagedStock: rows as unknown as Prisma.InputJsonValue,
          stockPostedAt: record.stockPostedAt ?? new Date(),
          stockPostedBy: record.stockPostedBy ?? user.userId,
          batchesCreated: { increment: pending.length },
          unitsPosted: {
            increment: pending.reduce((n, row) => n + row.qty, 0),
          },
          expiryReviewCount: {
            increment: pending.filter((row) => !row.expiryDate).length,
          },
        },
      });
      await this.audit.log(
        {
          tenantId: user.tenantId,
          branchId,
          actorUserId: user.userId,
          eventName: "products.import_stock_posted",
          entityName: "product_import",
          entityId: importId,
          payload: {
            version,
            stagedBy: record.stockStagedBy ?? record.createdBy,
            executor: user.userId,
            rows: pending.map((row) => ({
              rowNumber: row.rowNumber,
              batchId: row.postedBatchId,
              qty: row.qty,
            })),
            ...(command ? { command } : {}),
          },
        },
        tx,
      );
      return {
        view: await this.view(next, user, branchId, tx),
        batchesPosted: pending.length,
        unitsPosted: pending.reduce((n, row) => n + row.qty, 0),
      };
    });
  }

  private async transaction<T>(
    user: RequestUser,
    branchId: string,
    importId: string,
    work: (tx: Prisma.TransactionClient, record: ProductImport) => Promise<T>,
  ) {
    return this.prisma.$transaction(
      (tx) => this.locked(tx, user, branchId, importId, work),
      { timeout: 120_000, maxWait: 60_000 },
    );
  }

  private async locked<T>(
    tx: Prisma.TransactionClient,
    user: RequestUser,
    branchId: string,
    importId: string,
    work: (tx: Prisma.TransactionClient, record: ProductImport) => Promise<T>,
  ) {
    return tenantTransactionStorage.run(
      { tenantId: user.tenantId, branchId, client: tx },
      async () => {
        await tx.$queryRaw`SELECT id FROM product_import WHERE id = ${importId}::uuid AND tenant_id = ${user.tenantId}::uuid AND branch_id = ${branchId}::uuid FOR UPDATE`;
        const record = await tx.productImport.findFirst({
          where: { id: importId, tenantId: user.tenantId, branchId },
        });
        if (!record)
          throw new NotFoundException("Import not found at this branch.");
        await this.requireAccess(user, branchId, tx);
        if (!record.stockStaged || record.status !== "completed")
          throw new ConflictException("A completed staged import is required.");
        return work(tx, record);
      },
    );
  }

  private async requireAccess(
    user: RequestUser,
    branchId: string,
    tx: Prisma.TransactionClient,
  ) {
    if (
      !(await this.access.resolveLive(user, branchId, tx)).has(
        "products.import",
      )
    )
      throw new ForbiddenException(
        "Product import permission required at this branch.",
      );
  }

  private async view(
    record: {
      id: string;
      stockVersion: number;
      stagedStock: Prisma.JsonValue;
      stockStagedBy: string | null;
      createdBy: string;
      stockPostedAt: Date | null;
    },
    user: RequestUser,
    branchId: string,
    tx: Prisma.TransactionClient,
  ) {
    const access = await this.access.resolveLive(user, branchId, tx);
    if (!access.has("products.import"))
      throw new ForbiddenException(
        "Product import permission required at this branch.",
      );
    const rows = record.stagedStock as unknown as StagedStockRow[];
    return {
      importId: record.id,
      version: record.stockVersion,
      rows: rows.map((row) => ({
        ...row,
        costPrice: access.has("costs.view") ? row.costPrice : null,
      })),
      stagedBy: record.stockStagedBy ?? record.createdBy,
      postedAt: record.stockPostedAt,
    };
  }
  private checkVersion(record: { stockVersion: number }, version: number) {
    if (record.stockVersion !== version)
      throw new ConflictException(
        "Staged stock changed. Reload and review before continuing.",
      );
  }
  private body(input: unknown, keys: string[]) {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => !keys.includes(key))
    )
      throw new BadRequestException("Invalid staged stock request.");
    return input as Record<string, unknown>;
  }
  private version(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 1)
      throw new BadRequestException("A displayed stock version is required.");
    return value as number;
  }
}

export function parseStagedRows(input: unknown): StagedStockRow[] {
  if (!Array.isArray(input) || input.length > 20_000)
    throw new BadRequestException(
      "Staged stock must contain at most 20,000 rows.",
    );
  const numbers = new Set<number>();
  const batches = new Set<string>();
  let total = 0;
  return input.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new BadRequestException("Invalid stock row.");
    const row = value as StagedStockRow;
    if (
      Object.keys(row).some(
        (key) =>
          ![
            "rowNumber",
            "productId",
            "name",
            "categoryName",
            "qty",
            "costPrice",
            "sellingPrice",
            "batchNo",
            "expiryDate",
          ].includes(key),
      ) ||
      !Number.isInteger(row.rowNumber) ||
      row.rowNumber < 1 ||
      numbers.has(row.rowNumber) ||
      typeof row.productId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        row.productId,
      ) ||
      typeof row.name !== "string" ||
      !row.name.trim() ||
      row.name.length > 1000 ||
      (row.categoryName !== null &&
        (typeof row.categoryName !== "string" ||
          row.categoryName.length > 500)) ||
      !Number.isSafeInteger(row.qty) ||
      row.qty <= 0 ||
      row.qty > 2_147_483_647 ||
      ![row.costPrice, row.sellingPrice].every(
        (price) =>
          typeof price === "number" &&
          Number.isFinite(price) &&
          price >= 0 &&
          price === Math.round(price * 100) / 100 &&
          price <= 999_999_999.99,
      ) ||
      typeof row.batchNo !== "string" ||
      !row.batchNo.trim() ||
      row.batchNo.length > 200 ||
      (row.expiryDate !== null &&
        (typeof row.expiryDate !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/.test(row.expiryDate) ||
          !Number.isFinite(Date.parse(row.expiryDate)) ||
          new Date(row.expiryDate).toISOString() !== row.expiryDate))
    ) {
      throw new BadRequestException("Invalid or duplicate staged stock row.");
    }
    const batchKey = `${row.productId}:${row.batchNo.trim()}`;
    if (batches.has(batchKey))
      throw new BadRequestException("Duplicate staged product/batch.");
    numbers.add(row.rowNumber);
    batches.add(batchKey);
    total += row.qty;
    if (total > 2_147_483_647)
      throw new BadRequestException(
        "Total staged stock exceeds the import quantity limit.",
      );
    return {
      rowNumber: row.rowNumber,
      productId: row.productId,
      name: row.name.trim(),
      categoryName: row.categoryName,
      qty: row.qty,
      costPrice: row.costPrice,
      sellingPrice: row.sellingPrice,
      batchNo: row.batchNo.trim(),
      expiryDate: row.expiryDate,
    };
  });
}
