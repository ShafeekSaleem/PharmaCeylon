import { Injectable } from "@nestjs/common";
import { GoodsReturnStatus, type Prisma } from "@prisma/client";
import type {
  CounterUndoableImport,
  CounterWorkDetail,
  CounterWorkDetailKind,
  CounterWorkImportCategory,
  CounterWorkImportRow,
  CounterWorkLineProduct,
  CounterWorkNote,
  CounterWorkReceiptLine,
  CounterWorkReturnLine,
  CounterWorkStocktakeLine,
  CounterWorkTransferLine,
} from "@pharmaceylon/shared";
import { PrismaService } from "../prisma/prisma.service";
import type { StagedStockRow } from "../product-import/import-stock.service";
import { ProductImportService } from "../product-import/product-import.service";
import { AccessService } from "../security/access.service";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { StocktakesService } from "../stocktakes/stocktakes.service";
import { CounterWorkService, type CounterWorkItem, type DeliveryLine, deliveryLines } from "./counter-work.service";

/** The day of a stored date, which is how expiry is printed and compared. */
const day = (value: Date | string | null | undefined) =>
  value == null ? null : (typeof value === "string" ? value : value.toISOString()).slice(0, 10);
const money = (value: number) => value.toFixed(2);

type ProductInfo = { id: string; name: string; packLabel: string | null; unitsPerPack: number };

/**
 * P6 #52, counter reads: the lines behind one Counter work item, so the counter can show the
 * person at it exactly what they are confirming. Every read goes through `CounterWorkService.one`
 * first, so a document is readable here only while it waits in this branch's queue, to someone
 * who may execute it, and with the same approval check the list reports.
 */
@Injectable()
export class CounterWorkDetailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly work: CounterWorkService,
    private readonly stocktakes: StocktakesService,
    private readonly imports: ProductImportService,
  ) {}

  async detail(
    user: RequestUser,
    branchId: string,
    kind: CounterWorkDetailKind,
    id: string,
    asOf = new Date().toISOString(),
  ): Promise<CounterWorkDetail> {
    const access = await this.access.resolve(user, branchId);
    const item = await this.work.one(user, branchId, kind, id, access, asOf);
    const costs = access.has("costs.view");
    const { tenantId } = user;
    switch (kind) {
      case "prepared_receipt":
        return this.preparedReceipt(tenantId, item, costs);
      case "held_delivery":
        return this.heldDelivery(tenantId, item, costs);
      case "transfer_ship":
      case "transfer_receive":
        return this.transfer(tenantId, item, kind);
      case "stocktake":
        return this.stocktake(tenantId, branchId, item, access, costs);
      case "supplier_return":
        return this.supplierReturn(tenantId, item, costs);
      case "import_stock":
        return this.importStock(tenantId, item, costs);
    }
  }

  /** Decision 5: imports this counter may still undo. `products.import` at the branch. */
  async undoableImports(user: RequestUser, branchId: string): Promise<CounterUndoableImport[]> {
    const access = await this.access.resolve(user, branchId);
    if (!access.has("products.import")) return [];
    const rows = await this.imports.counterUndoable(user.tenantId, branchId);
    const names = await this.names(user.tenantId, rows.map((row) => row.createdBy));
    return rows.map((row) => ({
      importId: row.id,
      filename: row.filename,
      uploaded: { name: names.get(row.createdBy) ?? null, at: row.createdAt.toISOString() },
      productsCreated: row.productsCreated,
      productsUpdated: row.productsUpdated,
      batches: row.lines.length,
      units: row.lines.reduce((sum, line) => sum + line.qty, 0),
      lines: row.lines.map((line) => ({
        ...product(line.product),
        batchId: line.batchId,
        batchNo: line.batchNo,
        expiryDate: day(line.expiryDate),
        qty: line.qty,
        newProduct: line.newProduct,
      })),
    }));
  }

  // ── Per kind ────────────────────────────────────────────────────────────────────────────

  private async preparedReceipt(tenantId: string, item: CounterWorkItem, costs: boolean): Promise<CounterWorkDetail> {
    const row = await this.prisma.preparedReceipt.findFirstOrThrow({
      where: { tenantId, id: item.id },
      select: { payload: true, notes: true, preparedBy: true, preparedAt: true },
    });
    const notes = await this.notes(tenantId, [
      { label: "Note from the person who prepared it", text: row.notes, by: row.preparedBy, at: row.preparedAt },
    ]);
    return {
      ...base(item, "prepared_receipt"),
      notes,
      supplierDeliveryNote: deliveryNote(row.payload),
      amount: item.amount,
      lines: await this.receiptLines(tenantId, deliveryLines(row.payload), costs),
    };
  }

  private async heldDelivery(tenantId: string, item: CounterWorkItem, costs: boolean): Promise<CounterWorkDetail> {
    const row = await this.prisma.heldDelivery.findFirstOrThrow({
      where: { tenantId, id: item.id },
      select: {
        payload: true, preparedPayload: true, reasons: true, detail: true, decisionNote: true, corrected: true,
        requestedBy: true, requestedAt: true, decidedBy: true, decidedAt: true,
      },
    });
    const payload = row.preparedPayload ?? row.payload;
    const flags = (payload ?? {}) as { acceptOverDelivery?: boolean; acceptPriceVariance?: boolean };
    const notes = await this.notes(tenantId, [
      { label: "Why it was held", text: row.detail, by: row.requestedBy, at: row.requestedAt },
      { label: "Approver's note", text: row.decisionNote, by: row.decidedBy, at: row.decidedAt },
    ]);
    return {
      ...base(item, "held_delivery"),
      notes,
      supplierDeliveryNote: deliveryNote(payload),
      amount: item.amount,
      held: {
        reasons: row.reasons,
        detail: row.detail,
        acceptOverDelivery: flags.acceptOverDelivery === true,
        acceptPriceVariance: flags.acceptPriceVariance === true,
        corrected: row.corrected,
      },
      lines: await this.receiptLines(tenantId, deliveryLines(payload), costs),
    };
  }

  private async transfer(
    tenantId: string,
    item: CounterWorkItem,
    kind: "transfer_ship" | "transfer_receive",
  ): Promise<CounterWorkDetail> {
    const row = await this.prisma.transfer.findFirstOrThrow({
      where: { tenantId, id: item.id },
      select: {
        notes: true, requestedBy: true, createdAt: true,
        fromBranch: { select: { name: true } },
        toBranch: { select: { name: true } },
        items: {
          where: { tenantId },
          orderBy: { id: "asc" },
          select: {
            id: true, qty: true, receivedQty: true,
            product: { select: { id: true, name: true, packLabel: true, unitsPerPack: true } },
            batch: { select: { id: true, batchNo: true, expiryDate: true } },
          },
        },
      },
    });
    const lines: CounterWorkTransferLine[] = row.items.map((line) => ({
      ...product(line.product),
      transferItemId: line.id,
      batchId: line.batch?.id ?? null,
      batchNo: line.batch?.batchNo ?? null,
      expiryDate: day(line.batch?.expiryDate),
      qty: line.qty,
      receivedQty: line.receivedQty,
      remainingQty: Math.max(line.qty - line.receivedQty, 0),
    }));
    const notes = await this.notes(tenantId, [
      { label: "Transfer note", text: row.notes, by: row.requestedBy, at: row.createdAt },
    ]);
    return {
      ...base(item, kind),
      notes,
      otherBranch: kind === "transfer_ship" ? row.toBranch.name : row.fromBranch.name,
      lines,
    };
  }

  /**
   * Decision 3: the difference found at the count is applied to stock as it is now. The counter
   * holds `stocktakes.review` (the list's own gate), so the review read is never blind here.
   */
  private async stocktake(
    tenantId: string,
    branchId: string,
    item: CounterWorkItem,
    access: Parameters<StocktakesService["getOne"]>[3],
    costs: boolean,
  ): Promise<CounterWorkDetail> {
    const [doc, header] = await Promise.all([
      this.stocktakes.getOne(tenantId, branchId, item.id, access),
      this.prisma.stocktake.findFirstOrThrow({
        where: { tenantId, id: item.id },
        select: { notes: true, countedBy: true, submittedAt: true },
      }),
    ]);
    const products = await this.products(tenantId, doc.lines.map((line) => line.productId));
    let differences = 0;
    let value = 0;
    const lines: CounterWorkStocktakeLine[] = doc.lines.map((line) => {
      const onHandAtCount = line.expectedAtReview ?? 0;
      const now = onHandAtCount + (line.movementDeltaAfterCount ?? 0);
      const difference = line.countedQty == null ? null : line.countedQty - onHandAtCount;
      const cost = line.batch.costPrice;
      const valueAtCost = difference == null || cost == null || !costs ? null : difference * cost;
      if (difference) differences += 1;
      if (valueAtCost != null) value += valueAtCost;
      return {
        ...product(products.get(line.productId) ?? { id: line.productId, name: line.product.name, packLabel: null, unitsPerPack: 1 }),
        lineId: line.id,
        batchId: line.batch.id,
        batchNo: line.batch.batchNo,
        expiryDate: day(line.batch.expiryDate),
        onHandAtCount,
        countedQty: line.countedQty,
        difference,
        now,
        afterPost: now + (difference ?? 0),
        valueAtCost: valueAtCost == null ? null : money(valueAtCost),
        reviewNote: line.reviewNote,
      };
    });
    const notes = await this.notes(tenantId, [
      { label: "Count note", text: header.notes, by: header.countedBy, at: header.submittedAt },
    ]);
    return {
      ...base(item, "stocktake"),
      notes,
      totals: { lines: lines.length, differences, valueAtCost: costs ? money(value) : null },
      lines,
    };
  }

  private async supplierReturn(tenantId: string, item: CounterWorkItem, costs: boolean): Promise<CounterWorkDetail> {
    const row = await this.prisma.goodsReturn.findFirstOrThrow({
      where: {
        tenantId, id: item.id,
        status: { in: [GoodsReturnStatus.awaiting_logistics, GoodsReturnStatus.in_review] },
      },
      select: {
        reason: true, notes: true, requestedBy: true, createdAt: true,
        items: {
          where: { tenantId },
          orderBy: { id: "asc" },
          select: {
            id: true, qty: true, unitPrice: true, disposition: true,
            product: { select: { id: true, name: true, packLabel: true, unitsPerPack: true } },
            batch: { select: { id: true, batchNo: true, expiryDate: true, isQuarantined: true } },
          },
        },
      },
    });
    const lines: CounterWorkReturnLine[] = row.items.map((line) => ({
      ...product(line.product),
      itemId: line.id,
      batchId: line.batch?.id ?? null,
      batchNo: line.batch?.batchNo ?? null,
      expiryDate: day(line.batch?.expiryDate),
      qty: line.qty,
      quarantined: line.batch?.isQuarantined ?? false,
      disposition: line.disposition,
      unitPrice: costs ? money(Number(line.unitPrice)) : null,
    }));
    const notes = await this.notes(tenantId, [
      { label: "Reason", text: row.reason, by: row.requestedBy, at: row.createdAt },
      { label: "Note", text: row.notes, by: row.requestedBy, at: row.createdAt },
    ]);
    return { ...base(item, "supplier_return"), notes, amount: item.amount, lines };
  }

  private async importStock(tenantId: string, item: CounterWorkItem, costs: boolean): Promise<CounterWorkDetail> {
    const row = await this.prisma.productImport.findFirstOrThrow({
      where: { tenantId, id: item.id },
      select: { stagedStock: true, stockVersion: true },
    });
    const staged = (Array.isArray(row.stagedStock) ? row.stagedStock : []) as unknown as StagedStockRow[];
    const products = await this.products(tenantId, staged.map((r) => r.productId));
    const rows: CounterWorkImportRow[] = staged.map((r) => ({
      rowNumber: r.rowNumber,
      productId: r.productId,
      productName: products.get(r.productId)?.name ?? r.name,
      categoryName: r.categoryName,
      batchNo: r.batchNo,
      expiryDate: day(r.expiryDate),
      qty: r.qty,
      unitCost: costs ? money(Number(r.costPrice)) : null,
      posted: !!r.postedBatchId,
    }));
    return {
      ...base(item, "import_stock"),
      notes: [],
      stockVersion: row.stockVersion,
      categories: importCategories(rows),
      rows,
    };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────────────────

  private async receiptLines(tenantId: string, lines: DeliveryLine[], costs: boolean): Promise<CounterWorkReceiptLine[]> {
    const products = await this.products(tenantId, lines.map((line) => line.productId ?? ""));
    return lines.map((line, index) => {
      const info = products.get(line.productId ?? "");
      const unitsPerPack = line.unitsPerPack ?? info?.unitsPerPack ?? 1;
      const receivedQty = line.receivedQty ?? (line.packs != null ? line.packs * unitsPerPack : 0);
      const freeQty = line.freeQty ?? 0;
      const unitCost =
        line.costPrice ?? (line.packCost != null ? String(Number(line.packCost) / unitsPerPack) : null);
      return {
        productId: line.productId ?? "",
        productName: info?.name ?? "Unknown product",
        packLabel: info?.packLabel ?? null,
        unitsPerPack,
        batchId: null,
        batchNo: line.batchNo ?? null,
        expiryDate: day(line.expiryDate),
        index,
        packs: line.packs ?? null,
        receivedQty,
        freeQty,
        damagedQty: line.rejectedQty ?? 0,
        damagedReason: line.rejectedReason ?? null,
        unitsToStock: receivedQty + freeQty,
        packCost: costs && line.packCost != null ? money(Number(line.packCost)) : null,
        unitCost: costs && unitCost != null ? money(Number(unitCost)) : null,
      };
    });
  }

  private async products(tenantId: string, ids: string[]) {
    const wanted = [...new Set(ids.filter(Boolean))];
    const rows = wanted.length
      ? await this.prisma.product.findMany({
          where: { tenantId, id: { in: wanted } },
          select: { id: true, name: true, packLabel: true, unitsPerPack: true },
        })
      : [];
    return new Map<string, ProductInfo>(rows.map((row) => [row.id, row]));
  }

  private async names(tenantId: string, ids: (string | null)[]) {
    const wanted = [...new Set(ids.filter((id): id is string => !!id))];
    const users = wanted.length
      ? await this.prisma.appUser.findMany({ where: { tenantId, id: { in: wanted } }, select: { id: true, fullName: true } })
      : [];
    return new Map(users.map((u) => [u.id, u.fullName]));
  }

  /** Notes with text only, each signed with the writer's name. */
  private async notes(
    tenantId: string,
    raw: { label: string; text: string | null; by: string | null; at: Date | null }[],
  ): Promise<CounterWorkNote[]> {
    const present = raw.filter((note) => note.text?.trim());
    const names = await this.names(tenantId, present.map((note) => note.by));
    return present.map((note) => ({
      label: note.label,
      text: note.text!.trim(),
      by: note.by ? (names.get(note.by) ?? null) : null,
      at: note.at?.toISOString() ?? null,
    }));
  }
}

function base<K extends CounterWorkDetailKind>(item: CounterWorkItem, kind: K) {
  return {
    kind,
    id: item.id,
    reference: item.reference,
    subject: item.subject,
    approval: item.approval,
    task: item.task,
    requested: item.requested,
    approved: item.approved,
    dispatched: item.dispatched,
  };
}

function product(p: ProductInfo): CounterWorkLineProduct {
  return { productId: p.id, productName: p.name, packLabel: p.packLabel, unitsPerPack: p.unitsPerPack };
}

function deliveryNote(payload: Prisma.JsonValue): string | null {
  const note = (payload as { supplierDeliveryNote?: unknown } | null)?.supplierDeliveryNote;
  return typeof note === "string" && note.trim() ? note.trim() : null;
}

/** Each category posts once (`categoryName` on the post); rows with none form their own group. */
export function importCategories(rows: CounterWorkImportRow[]): CounterWorkImportCategory[] {
  const groups = new Map<string | null, CounterWorkImportRow[]>();
  for (const row of rows) groups.set(row.categoryName, [...(groups.get(row.categoryName) ?? []), row]);
  return [...groups.entries()]
    .map(([categoryName, members]) => ({
      categoryName,
      rows: members.length,
      batches: new Set(members.map((r) => `${r.productId}\u0000${r.batchNo}`)).size,
      units: members.reduce((sum, r) => sum + r.qty, 0),
      posted: members.every((r) => r.posted),
    }))
    .sort((a, b) => (a.categoryName ?? "￿").localeCompare(b.categoryName ?? "￿"));
}
