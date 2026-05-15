import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CreateProductDto } from "./dto/create-product.dto";
import { UpdateProductDto } from "./dto/update-product.dto";
import { buildProductWhere } from "./product-query.util";

const SORTABLE_FIELDS = new Set([
  "name",
  "sku",
  "brandName",
  "reorderLevel",
  "createdAt",
  "updatedAt",
]);

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(
    tenantId: string,
    branchId: string | undefined,
    query: {
      q?: string;
      skip?: number;
      take?: number;
      dosageForm?: string;
      brandName?: string;
      isControlled?: string;
      status?: string;
      lowStock?: boolean;
      sortBy?: string;
      sortDir?: string;
    },
  ) {
    const take = Math.min(query.take ?? 50, 200);
    const skip = query.skip ?? 0;

    const { where, isEmpty } = await buildProductWhere(
      this.prisma,
      tenantId,
      branchId,
      query,
    );

    if (isEmpty) {
      return { items: [], total: 0, skip, take };
    }

    const sortField = SORTABLE_FIELDS.has(query.sortBy ?? "")
      ? query.sortBy!
      : "name";
    const sortDirection: Prisma.SortOrder =
      query.sortDir === "desc" ? "desc" : "asc";

    const [items, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        orderBy: { [sortField]: sortDirection },
        skip,
        take,
      }),
      this.prisma.product.count({ where }),
    ]);
    return { items, total, skip, take };
  }

  async getById(tenantId: string, id: string) {
    const product = await this.prisma.product.findFirst({
      where: { id, tenantId },
    });
    if (!product) {
      throw new NotFoundException("Product not found");
    }
    return product;
  }

  async create(tenantId: string, userId: string, dto: CreateProductDto) {
    try {
      const product = await this.prisma.product.create({
        data: {
          tenantId,
          sku: dto.sku.trim(),
          barcode: dto.barcode?.trim() || null,
          name: dto.name.trim(),
          brandName: dto.brandName?.trim() || null,
          genericName: dto.genericName?.trim() || null,
          manufacturer: dto.manufacturer?.trim() || null,
          dosageForm: dto.dosageForm?.trim() || null,
          strength: dto.strength?.trim() || null,
          unit: dto.unit?.trim() || null,
          imageUrl: dto.imageUrl?.trim() || null,
          isControlled: dto.isControlled ?? false,
          reorderLevel: dto.reorderLevel ?? 0,
        },
      });
      await this.audit.log({
        tenantId,
        actorUserId: userId,
        eventName: "product.created",
        entityName: "product",
        entityId: product.id,
        payload: { sku: product.sku },
      });
      return product;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConflictException("SKU must be unique within the tenant");
      }
      throw e;
    }
  }

  async update(tenantId: string, userId: string, id: string, dto: UpdateProductDto) {
    await this.getById(tenantId, id);
    const product = await this.prisma.product.update({
      where: { id },
      data: {
        ...(dto.barcode !== undefined ? { barcode: dto.barcode?.trim() || null } : {}),
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.brandName !== undefined ? { brandName: dto.brandName?.trim() || null } : {}),
        ...(dto.genericName !== undefined ? { genericName: dto.genericName?.trim() || null } : {}),
        ...(dto.manufacturer !== undefined ? { manufacturer: dto.manufacturer?.trim() || null } : {}),
        ...(dto.dosageForm !== undefined ? { dosageForm: dto.dosageForm?.trim() || null } : {}),
        ...(dto.strength !== undefined ? { strength: dto.strength?.trim() || null } : {}),
        ...(dto.unit !== undefined ? { unit: dto.unit?.trim() || null } : {}),
        ...(dto.imageUrl !== undefined ? { imageUrl: dto.imageUrl?.trim() || null } : {}),
        ...(dto.isControlled !== undefined ? { isControlled: dto.isControlled } : {}),
        ...(dto.reorderLevel !== undefined ? { reorderLevel: dto.reorderLevel } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      eventName: "product.updated",
      entityName: "product",
      entityId: product.id,
    });
    return product;
  }

  async remove(tenantId: string, userId: string, id: string) {
    const existing = await this.getById(tenantId, id);
    try {
      await this.prisma.product.delete({ where: { id } });
      await this.audit.log({
        tenantId,
        actorUserId: userId,
        eventName: "product.deleted",
        entityName: "product",
        entityId: id,
        payload: { sku: existing.sku },
      });
      return { ok: true };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003") {
        throw new ConflictException(
          "Product cannot be deleted because it is referenced by inventory or sales records",
        );
      }
      throw e;
    }
  }
}
