import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { nextDocumentNumber } from "../common/document-sequence.util";
import { assertOneScopedMutation } from "../common/scoped-mutation.util";
import { PrismaService } from "../prisma/prisma.service";
import { HoldSaleDto } from "./dto/hold-sale.dto";

/** Parked carts. Nothing is reserved — stock is re-validated when the sale posts. */
@Injectable()
export class HeldSalesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string, branchId: string) {
    const rows = await this.prisma.heldSale.findMany({
      where: { tenantId, branchId },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: {
        id: true,
        holdRef: true,
        label: true,
        itemCount: true,
        total: true,
        createdAt: true,
        payload: true,
        holder: { select: { id: true, fullName: true } },
      },
    });

    return rows.map((row) => {
      const meta =
        row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
          ? ((row.payload as { meta?: Record<string, unknown> }).meta ?? {})
          : {};
      const holdReason =
        typeof meta.holdReason === "string" ? meta.holdReason : null;
      const needsPharmacist =
        meta.needsPharmacist === true || holdReason === "awaiting_pharmacist";
      return {
        id: row.id,
        holdRef: row.holdRef,
        label: row.label,
        itemCount: row.itemCount,
        total: row.total.toFixed(2),
        createdAt: row.createdAt.toISOString(),
        heldByName: row.holder.fullName,
        needsPharmacist,
        holdReason,
      };
    });
  }

  async getOne(tenantId: string, branchId: string, id: string) {
    const row = await this.prisma.heldSale.findFirst({
      where: { id, tenantId, branchId },
    });
    if (!row) throw new NotFoundException("Held sale not found");
    return {
      id: row.id,
      holdRef: row.holdRef,
      label: row.label,
      itemCount: row.itemCount,
      total: row.total.toFixed(2),
      createdAt: row.createdAt.toISOString(),
      payload: row.payload,
    };
  }

  async hold(tenantId: string, branchId: string, userId: string, dto: HoldSaleDto) {
    const created = await this.prisma.$transaction(async (tx) => {
      const holdRef = await nextDocumentNumber(tx, tenantId, branchId, "held_sale", "HOLD-", 4);
      return tx.heldSale.create({
        data: {
          tenantId,
          branchId,
          holdRef,
          label: dto.label?.trim() || null,
          itemCount: dto.itemCount,
          total: new Prisma.Decimal(dto.total),
          payload: {
            lines: dto.lines,
            meta: dto.meta ?? {},
          } as Prisma.InputJsonValue,
          heldBy: userId,
        },
        select: { id: true, holdRef: true, createdAt: true },
      });
    });

    return {
      id: created.id,
      holdRef: created.holdRef,
      createdAt: created.createdAt.toISOString(),
    };
  }

  /**
   * Recall consumes the hold: the row is deleted in the same transaction as the
   * read, so a parked cart can never be recalled twice (no duplicate/orphan holds)
   * and it disappears from the parked list the instant it lands back in the cart.
   */
  async recall(tenantId: string, branchId: string, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.heldSale.findFirst({
        where: { id, tenantId, branchId },
      });
      if (!row) throw new NotFoundException("Held sale not found");
      const mutation = await tx.heldSale.deleteMany({ where: { id, tenantId, branchId } });
      assertOneScopedMutation(mutation, "Held sale");
      return {
        id: row.id,
        holdRef: row.holdRef,
        label: row.label,
        itemCount: row.itemCount,
        total: row.total.toFixed(2),
        createdAt: row.createdAt.toISOString(),
        payload: row.payload,
      };
    });
  }

  async discard(tenantId: string, branchId: string, id: string) {
    const existing = await this.prisma.heldSale.findFirst({
      where: { id, tenantId, branchId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException("Held sale not found");
    const mutation = await this.prisma.heldSale.deleteMany({ where: { id, tenantId, branchId } });
    assertOneScopedMutation(mutation, "Held sale");
    return { id, discarded: true };
  }
}
