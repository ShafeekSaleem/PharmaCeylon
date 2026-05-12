import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CreateSupplierDto } from "./dto/create-supplier.dto";
import { UpdateSupplierDto } from "./dto/update-supplier.dto";

@Injectable()
export class SuppliersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string) {
    return this.prisma.supplier.findMany({
      where: { tenantId, isActive: true },
      orderBy: { name: "asc" },
    });
  }

  async getById(tenantId: string, id: string) {
    const row = await this.prisma.supplier.findFirst({ where: { id, tenantId } });
    if (!row) throw new NotFoundException("Supplier not found");
    return row;
  }

  async create(tenantId: string, userId: string, dto: CreateSupplierDto) {
    try {
      const supplier = await this.prisma.supplier.create({
        data: {
          tenantId,
          code: dto.code.trim(),
          name: dto.name.trim(),
          leadTimeDays: dto.leadTimeDays ?? 2,
          paymentTermsDays: dto.paymentTermsDays ?? 30,
        },
      });
      await this.audit.log({
        tenantId,
        actorUserId: userId,
        eventName: "supplier.created",
        entityName: "supplier",
        entityId: supplier.id,
        payload: { code: supplier.code },
      });
      return supplier;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConflictException("Supplier code must be unique within the tenant");
      }
      throw e;
    }
  }

  async update(tenantId: string, userId: string, id: string, dto: UpdateSupplierDto) {
    await this.getById(tenantId, id);
    const supplier = await this.prisma.supplier.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.leadTimeDays !== undefined ? { leadTimeDays: dto.leadTimeDays } : {}),
        ...(dto.paymentTermsDays !== undefined ? { paymentTermsDays: dto.paymentTermsDays } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      eventName: "supplier.updated",
      entityName: "supplier",
      entityId: supplier.id,
    });
    return supplier;
  }
}
