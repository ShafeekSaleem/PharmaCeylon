import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CreateCustomerDto } from "./dto/create-customer.dto";

const CUSTOMER_SELECT = {
  id: true,
  fullName: true,
  phone: true,
  email: true,
  address: true,
  notes: true,
  isActive: true,
  createdAt: true,
} satisfies Prisma.CustomerSelect;

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  async search(tenantId: string, q: string | undefined, take = 20) {
    const term = q?.trim();
    return this.prisma.customer.findMany({
      where: {
        tenantId,
        isActive: true,
        ...(term
          ? {
              OR: [
                { fullName: { contains: term, mode: "insensitive" } },
                { phone: { contains: term, mode: "insensitive" } },
                { email: { contains: term, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      select: CUSTOMER_SELECT,
      orderBy: { fullName: "asc" },
      take: Math.min(Math.max(take, 1), 50),
    });
  }

  async getOne(tenantId: string, id: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, tenantId },
      select: CUSTOMER_SELECT,
    });
    if (!customer) throw new NotFoundException("Customer not found");
    return customer;
  }

  async create(tenantId: string, dto: CreateCustomerDto) {
    const phone = dto.phone?.trim() || null;
    if (phone) {
      const clash = await this.prisma.customer.findFirst({
        where: { tenantId, phone },
        select: { id: true, fullName: true },
      });
      if (clash) {
        throw new BadRequestException(
          `Phone ${phone} already belongs to ${clash.fullName}`,
        );
      }
    }

    return this.prisma.customer.create({
      data: {
        tenantId,
        fullName: dto.fullName.trim(),
        phone,
        email: dto.email?.trim() || null,
        address: dto.address?.trim() || null,
        notes: dto.notes?.trim() || null,
      },
      select: CUSTOMER_SELECT,
    });
  }
}
