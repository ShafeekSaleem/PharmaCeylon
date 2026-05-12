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

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(
    tenantId: string,
    query: { q?: string; skip?: number; take?: number },
  ) {
    const take = Math.min(query.take ?? 50, 200);
    const skip = query.skip ?? 0;
    const where: Prisma.ProductWhereInput = {
      tenantId,
      isActive: true,
      ...(query.q?.trim()
        ? {
            OR: [
              { name: { contains: query.q.trim(), mode: "insensitive" } },
              { sku: { contains: query.q.trim(), mode: "insensitive" } },
              { barcode: { contains: query.q.trim(), mode: "insensitive" } },
              { brandName: { contains: query.q.trim(), mode: "insensitive" } },
              { genericName: { contains: query.q.trim(), mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        orderBy: { name: "asc" },
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
}
