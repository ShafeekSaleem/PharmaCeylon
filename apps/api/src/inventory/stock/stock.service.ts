import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  Prisma,
  StockBucket,
  StockMovementType,
  StockReservationStatus,
} from "@prisma/client";
import { ensureProductsRanged } from "../../products/product-range.util";
import {
  applyBucketDeltas,
  isWhollyQuarantined,
  planIssue,
  toBalance,
  ZERO_QUANTITIES,
  type BalanceViolation,
  type BatchBalance,
  type BatchQuantities,
  type BucketDelta,
} from "./stock-balance";
import { QUARANTINE_REFERENCE_TYPE, type QuarantineReasonCode } from "./stock-reasons";

type Tx = Prisma.TransactionClient;

export type StockPostContext = {
  tenantId: string;
  branchId: string;
  userId: string | null;
  referenceType: string;
  referenceId: string;
  occurredAt?: Date;
};

export type StockMovementInput = {
  productId: string;
  batchId: string;
  movementType: StockMovementType;
  /** Signed: positive adds units to `bucket`, negative takes them out. */
  qtyDelta: number;
  bucket?: StockBucket;
  reason?: string | null;
  reasonCode?: string | null;
};

export type PostOptions = {
  /** Stocktake postings only — see `applyBucketDeltas`. */
  allowReservedShortfall?: boolean;
};

export type IssueLine = {
  productId: string;
  batchId: string;
  qty: number;
  movementType: StockMovementType;
  from?: "sellable" | "quarantine" | "quarantine_first" | "sellable_first";
  reason?: string | null;
  reasonCode?: string | null;
};

export type ReceiveLine = {
  productId: string;
  batchId: string;
  qty: number;
  movementType: StockMovementType;
  reason?: string | null;
  reasonCode?: string | null;
};

export type ReservationLine = {
  productId: string;
  batchId: string;
  qty: number;
  sourceLineId?: string | null;
};

export type ReservationSource = {
  tenantId: string;
  branchId: string;
  userId: string | null;
  sourceType: string;
  sourceId: string;
};

export type BatchBalanceRow = BatchBalance & {
  batchId: string;
  productId: string;
  branchId: string;
};

/** Movement types that put units on a shelf — stock arriving ranges its product. */
const ARRIVAL_TYPES = new Set<StockMovementType>([
  StockMovementType.purchase_in,
  StockMovementType.transfer_in,
  StockMovementType.adjustment_in,
  StockMovementType.opening_stock,
  StockMovementType.stocktake_in,
  StockMovementType.customer_return_in,
  StockMovementType.sale_void_in,
  StockMovementType.sale_refund_in,
]);

export class InsufficientStockException extends BadRequestException {
  constructor(
    readonly batchId: string,
    readonly violation: BalanceViolation,
    label: string,
  ) {
    super(
      violation.kind === "insufficient_quarantined"
        ? `Only ${violation.quarantined} quarantined on ${label} (${violation.requested} requested).`
        : `Only ${Math.max(0, violation.available)} available on ${label} (${violation.requested} requested).`,
    );
  }
}

/**
 * The only code allowed to change stock.
 *
 * Every sale, receipt, transfer, return, stocktake and adjustment used to write ledger rows
 * itself, each after its own "sum the ledger, then insert" check. Under READ COMMITTED two of
 * those checks could pass at once, and nothing stopped the last unit being sold twice. Here
 * every change:
 *
 *  1. locks the batch rows involved, in id order (so two transactions never deadlock on them),
 *  2. reads the batch's running totals from `batch_stock`,
 *  3. refuses anything that would take more than is available,
 *  4. appends the ledger rows and moves the running totals in the same transaction.
 *
 * All methods take the caller's transaction client and must run inside one; the caller owns
 * the document status change that goes with the stock change, so they commit together.
 * `scripts/check-stock-writes.mjs` fails the lint step if a ledger write appears anywhere else.
 */
@Injectable()
export class StockService {
  async lockBatches(tx: Tx, tenantId: string, batchIds: readonly string[]): Promise<void> {
    const ids = [...new Set(batchIds.filter(Boolean))].sort();
    if (ids.length === 0) return;
    await tx.$queryRaw`
      SELECT id FROM batch
      WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${ids}::uuid[])
      ORDER BY id
      FOR UPDATE
    `;
  }

  /** Current totals for batches; batches with no stock yet read as zero. Does not lock. */
  async balances(
    tx: Tx,
    tenantId: string,
    batchIds: readonly string[],
  ): Promise<Map<string, BatchBalanceRow>> {
    const ids = [...new Set(batchIds.filter(Boolean))];
    const result = new Map<string, BatchBalanceRow>();
    if (ids.length === 0) return result;
    const rows = await tx.batchStock.findMany({
      where: { tenantId, batchId: { in: ids } },
    });
    for (const row of rows) {
      result.set(row.batchId, {
        batchId: row.batchId,
        productId: row.productId,
        branchId: row.branchId,
        ...toBalance({
          onHand: row.onHandQty,
          quarantined: row.quarantinedQty,
          reserved: row.reservedQty,
        }),
      });
    }
    return result;
  }

  /** Low-level: append ledger rows after checking them against the batch totals. */
  async post(
    tx: Tx,
    ctx: StockPostContext,
    movements: readonly StockMovementInput[],
    opts: PostOptions = {},
  ): Promise<void> {
    if (movements.length === 0) return;
    for (const m of movements) {
      if (!Number.isInteger(m.qtyDelta) || m.qtyDelta === 0) {
        throw new BadRequestException("Stock quantities must be whole, non-zero numbers");
      }
    }

    const batchIds = [...new Set(movements.map((m) => m.batchId))];
    await this.lockBatches(tx, ctx.tenantId, batchIds);
    const batches = await this.loadBatches(tx, ctx.tenantId, ctx.branchId, batchIds);
    for (const m of movements) {
      const batch = batches.get(m.batchId)!;
      if (batch.productId !== m.productId) {
        throw new BadRequestException(`Batch ${batch.batchNo} does not belong to this product`);
      }
    }

    const balances = await this.balances(tx, ctx.tenantId, batchIds);
    const deltasByBatch = new Map<string, BucketDelta[]>();
    for (const m of movements) {
      const list = deltasByBatch.get(m.batchId) ?? [];
      list.push({ bucket: m.bucket ?? StockBucket.sellable, qtyDelta: m.qtyDelta });
      deltasByBatch.set(m.batchId, list);
    }

    const nextByBatch = new Map<string, BatchQuantities>();
    for (const [batchId, deltas] of deltasByBatch) {
      const current = balances.get(batchId) ?? ZERO_QUANTITIES;
      const { next, violation } = applyBucketDeltas(current, deltas, opts);
      if (violation) {
        const batch = batches.get(batchId)!;
        throw new InsufficientStockException(
          batchId,
          violation,
          `batch ${batch.batchNo} of ${batch.productName}`,
        );
      }
      nextByBatch.set(batchId, next);
    }

    const occurredAt = ctx.occurredAt ?? new Date();
    await tx.stockLedger.createMany({
      data: movements.map((m) => ({
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        productId: m.productId,
        batchId: m.batchId,
        movementType: m.movementType,
        qtyDelta: m.qtyDelta,
        bucket: m.bucket ?? StockBucket.sellable,
        referenceType: ctx.referenceType,
        referenceId: ctx.referenceId,
        reason: m.reason?.trim() || null,
        reasonCode: m.reasonCode ?? null,
        occurredAt,
        createdBy: ctx.userId,
      })),
    });

    for (const [batchId, deltas] of deltasByBatch) {
      const batch = batches.get(batchId)!;
      const onHandDelta = deltas.reduce((sum, d) => sum + d.qtyDelta, 0);
      const quarantineDelta = deltas
        .filter((d) => d.bucket === StockBucket.quarantine)
        .reduce((sum, d) => sum + d.qtyDelta, 0);
      await tx.batchStock.upsert({
        where: { batchId },
        create: {
          batchId,
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          productId: batch.productId,
          onHandQty: onHandDelta,
          quarantinedQty: quarantineDelta,
          reservedQty: 0,
        },
        update: {
          onHandQty: { increment: onHandDelta },
          quarantinedQty: { increment: quarantineDelta },
        },
      });

      const next = nextByBatch.get(batchId)!;
      const wholly = isWhollyQuarantined(next);
      const heldReason = movements.find(
        (m) =>
          m.batchId === batchId &&
          (m.bucket ?? StockBucket.sellable) === StockBucket.quarantine &&
          m.qtyDelta > 0,
      );
      if (heldReason || next.quarantined <= 0 || wholly !== batch.isQuarantined) {
        await tx.batch.updateMany({
          where: { id: batchId, tenantId: ctx.tenantId },
          data: {
            isQuarantined: wholly,
            ...(heldReason
              ? {
                  quarantinedAt: occurredAt,
                  quarantineReason: heldReason.reason?.trim() || batch.quarantineReason,
                }
              : next.quarantined <= 0
                ? { quarantinedAt: null, quarantineReason: null }
                : {}),
          },
        });
      }
    }

    const arrivals = movements
      .filter((m) => m.qtyDelta > 0 && ARRIVAL_TYPES.has(m.movementType))
      .map((m) => m.productId);
    await ensureProductsRanged(tx, ctx.tenantId, arrivals);
  }

  /** Units in: purchases, transfers in, returns, positive corrections. Always sellable. */
  async receive(tx: Tx, ctx: StockPostContext, lines: readonly ReceiveLine[]): Promise<void> {
    await this.post(
      tx,
      ctx,
      lines.map((line) => ({
        productId: line.productId,
        batchId: line.batchId,
        movementType: line.movementType,
        qtyDelta: this.positive(line.qty),
        bucket: StockBucket.sellable,
        reason: line.reason,
        reasonCode: line.reasonCode,
      })),
    );
  }

  /** Units out, taken from the bucket(s) `from` says. */
  async issue(
    tx: Tx,
    ctx: StockPostContext,
    lines: readonly IssueLine[],
    opts: PostOptions = {},
  ): Promise<void> {
    if (lines.length === 0) return;
    const batchIds = lines.map((line) => line.batchId);
    await this.lockBatches(tx, ctx.tenantId, batchIds);
    const balances = await this.balances(tx, ctx.tenantId, batchIds);

    const running = new Map<string, BatchQuantities>();
    const movements: StockMovementInput[] = [];
    for (const line of lines) {
      const qty = this.positive(line.qty);
      const current =
        running.get(line.batchId) ?? balances.get(line.batchId) ?? ZERO_QUANTITIES;
      const deltas = planIssue(toBalance(current), qty, line.from ?? "sellable", opts);
      running.set(line.batchId, applyBucketDeltas(current, deltas, opts).next);
      for (const d of deltas) {
        movements.push({
          productId: line.productId,
          batchId: line.batchId,
          movementType: line.movementType,
          qtyDelta: d.qtyDelta,
          bucket: d.bucket,
          reason: line.reason,
          reasonCode: line.reasonCode,
        });
      }
    }
    await this.post(tx, ctx, movements, opts);
  }

  /** Move available units into quarantine. On hand does not change. */
  async quarantine(
    tx: Tx,
    ctx: Omit<StockPostContext, "referenceType" | "referenceId"> & { referenceId: string },
    line: { productId: string; batchId: string; qty: number; reasonCode: QuarantineReasonCode; reason?: string | null },
  ): Promise<void> {
    const qty = this.positive(line.qty);
    const base = {
      productId: line.productId,
      batchId: line.batchId,
      movementType: StockMovementType.quarantine_hold,
      reason: line.reason,
      reasonCode: line.reasonCode,
    };
    await this.post(tx, { ...ctx, referenceType: QUARANTINE_REFERENCE_TYPE }, [
      { ...base, qtyDelta: -qty, bucket: StockBucket.sellable },
      { ...base, qtyDelta: qty, bucket: StockBucket.quarantine },
    ]);
  }

  /** Return quarantined units to sellable stock. On hand does not change. */
  async release(
    tx: Tx,
    ctx: Omit<StockPostContext, "referenceType" | "referenceId"> & { referenceId: string },
    line: { productId: string; batchId: string; qty: number; reason?: string | null },
  ): Promise<void> {
    const qty = this.positive(line.qty);
    const base = {
      productId: line.productId,
      batchId: line.batchId,
      movementType: StockMovementType.quarantine_release,
      reason: line.reason,
    };
    await this.post(tx, { ...ctx, referenceType: QUARANTINE_REFERENCE_TYPE }, [
      { ...base, qtyDelta: -qty, bucket: StockBucket.quarantine },
      { ...base, qtyDelta: qty, bucket: StockBucket.sellable },
    ]);
  }

  /** Promise available units to a document. On hand does not change; available does. */
  async reserve(
    tx: Tx,
    source: ReservationSource,
    lines: readonly ReservationLine[],
  ): Promise<void> {
    if (lines.length === 0) return;
    const batchIds = [...new Set(lines.map((line) => line.batchId))];
    await this.lockBatches(tx, source.tenantId, batchIds);
    const batches = await this.loadBatches(tx, source.tenantId, source.branchId, batchIds);
    const balances = await this.balances(tx, source.tenantId, batchIds);

    const requestedByBatch = new Map<string, number>();
    for (const line of lines) {
      const qty = this.positive(line.qty);
      const batch = batches.get(line.batchId)!;
      if (batch.productId !== line.productId) {
        throw new BadRequestException(`Batch ${batch.batchNo} does not belong to this product`);
      }
      requestedByBatch.set(line.batchId, (requestedByBatch.get(line.batchId) ?? 0) + qty);
    }
    for (const [batchId, requested] of requestedByBatch) {
      const balance = balances.get(batchId) ?? toBalance(ZERO_QUANTITIES);
      if (balance.available < requested) {
        const batch = batches.get(batchId)!;
        throw new InsufficientStockException(
          batchId,
          { kind: "insufficient_available", available: balance.available, requested },
          `batch ${batch.batchNo} of ${batch.productName}`,
        );
      }
    }

    await tx.stockReservation.createMany({
      data: lines.map((line) => ({
        tenantId: source.tenantId,
        branchId: source.branchId,
        productId: line.productId,
        batchId: line.batchId,
        qty: line.qty,
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        sourceLineId: line.sourceLineId ?? null,
        createdBy: source.userId,
      })),
    });
    for (const [batchId, requested] of requestedByBatch) {
      const batch = batches.get(batchId)!;
      await tx.batchStock.upsert({
        where: { batchId },
        create: {
          batchId,
          tenantId: source.tenantId,
          branchId: source.branchId,
          productId: batch.productId,
          reservedQty: requested,
        },
        update: { reservedQty: { increment: requested } },
      });
    }
  }

  /** The document was cancelled: its reserved units become available again. */
  releaseReservations(
    tx: Tx,
    tenantId: string,
    sourceType: string,
    sourceId: string,
  ) {
    return this.closeReservations(tx, tenantId, sourceType, sourceId, StockReservationStatus.released);
  }

  /** The document is about to move the reserved units; the caller posts the movement next. */
  consumeReservations(
    tx: Tx,
    tenantId: string,
    sourceType: string,
    sourceId: string,
  ) {
    return this.closeReservations(tx, tenantId, sourceType, sourceId, StockReservationStatus.consumed);
  }

  private async closeReservations(
    tx: Tx,
    tenantId: string,
    sourceType: string,
    sourceId: string,
    status: "released" | "consumed",
  ) {
    const active = await tx.stockReservation.findMany({
      where: { tenantId, sourceType, sourceId, status: StockReservationStatus.active },
      select: { id: true, batchId: true, productId: true, qty: true, sourceLineId: true },
    });
    if (active.length === 0) return active;

    await this.lockBatches(tx, tenantId, active.map((row) => row.batchId));
    const closed = await tx.stockReservation.updateMany({
      where: {
        tenantId,
        id: { in: active.map((row) => row.id) },
        status: StockReservationStatus.active,
      },
      data:
        status === StockReservationStatus.released
          ? { status, releasedAt: new Date() }
          : { status, consumedAt: new Date() },
    });
    if (closed.count !== active.length) {
      throw new ConflictException("Stock reservation changed — refresh and try again");
    }

    const byBatch = new Map<string, number>();
    for (const row of active) byBatch.set(row.batchId, (byBatch.get(row.batchId) ?? 0) + row.qty);
    for (const [batchId, qty] of byBatch) {
      await tx.batchStock.updateMany({
        where: { batchId, tenantId },
        data: { reservedQty: { decrement: qty } },
      });
    }
    return active;
  }

  private positive(qty: number): number {
    if (!Number.isInteger(qty) || qty <= 0) {
      throw new BadRequestException("Quantity must be a whole number greater than zero");
    }
    return qty;
  }

  private async loadBatches(tx: Tx, tenantId: string, branchId: string, batchIds: string[]) {
    const rows = await tx.batch.findMany({
      where: { tenantId, id: { in: batchIds } },
      select: {
        id: true,
        branchId: true,
        productId: true,
        batchNo: true,
        isQuarantined: true,
        quarantineReason: true,
        product: { select: { name: true } },
      },
    });
    const map = new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          branchId: row.branchId,
          productId: row.productId,
          batchNo: row.batchNo,
          isQuarantined: row.isQuarantined,
          quarantineReason: row.quarantineReason,
          productName: row.product.name,
        },
      ]),
    );
    for (const id of batchIds) {
      const batch = map.get(id);
      if (!batch || batch.branchId !== branchId) {
        throw new NotFoundException("Batch not found at this branch");
      }
    }
    return map;
  }
}
