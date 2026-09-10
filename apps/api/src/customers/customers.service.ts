import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { assertOneScopedMutation } from "../common/scoped-mutation.util";
import { PrismaService } from "../prisma/prisma.service";
import { CreateCustomerDto } from "./dto/create-customer.dto";
import { UpdateCustomerDto } from "./dto/update-customer.dto";

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

  /**
   * Paginated directory for the Customers page.
   *
   * Distinct from `search`, which exists for the POS picker: that one is capped
   * at 50 and hides inactive records because the counter must never attach a
   * retired profile to a new sale. A management screen needs the opposite —
   * a total count, real paging, and the ability to see what has been
   * deactivated.
   */
  async list(
    tenantId: string,
    filters: { q?: string; status?: string; page?: number; pageSize?: number } = {},
  ) {
    const term = filters.q?.trim();
    const pageSize = Math.min(Math.max(filters.pageSize ?? 25, 1), 100);
    const page = Math.max(filters.page ?? 1, 1);

    const where: Prisma.CustomerWhereInput = {
      tenantId,
      ...(filters.status === "active"
        ? { isActive: true }
        : filters.status === "inactive"
          ? { isActive: false }
          : {}),
      ...(term
        ? {
            OR: [
              { fullName: { contains: term, mode: "insensitive" } },
              { phone: { contains: term, mode: "insensitive" } },
              { email: { contains: term, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.customer.findMany({
        where,
        select: {
          ...CUSTOMER_SELECT,
          _count: { select: { sales: true, prescriptions: true } },
        },
        orderBy: { fullName: "asc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.customer.count({ where }),
    ]);

    return { items, total, page, pageSize };
  }

  async getOne(tenantId: string, id: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, tenantId },
      select: CUSTOMER_SELECT,
    });
    if (!customer) throw new NotFoundException("Customer not found");
    return customer;
  }

  /**
   * Profile plus the dispensing record behind it.
   *
   * This is the reason the page exists: checking a repeat means seeing what
   * someone was actually given and when, which was previously only reachable
   * mid-sale through the POS. Deliberately tenant-scoped rather than
   * branch-scoped — a customer who filled a prescription at one branch and
   * comes back to another is the normal case, not an edge case.
   */
  async getProfile(tenantId: string, id: string, historyLimit = 20) {
    const customer = await this.getOne(tenantId, id);

    const [sales, prescriptions, totals] = await Promise.all([
      this.prisma.sale.findMany({
        where: { tenantId, customerId: id },
        select: {
          id: true,
          invoiceNo: true,
          status: true,
          soldAt: true,
          grandTotal: true,
          branch: { select: { name: true } },
          prescription: { select: { id: true, rxNumber: true } },
          _count: { select: { items: true } },
        },
        orderBy: { soldAt: "desc" },
        take: Math.min(Math.max(historyLimit, 1), 100),
      }),
      this.prisma.prescription.findMany({
        where: { tenantId, customerId: id },
        select: {
          id: true,
          rxNumber: true,
          patientName: true,
          doctorName: true,
          issuedOn: true,
          validUntil: true,
          branch: { select: { name: true } },
        },
        orderBy: { issuedOn: "desc" },
        take: 20,
      }),
      // Lifetime value counts posted sales only — a voided or refunded sale is
      // not spend, and showing it as such would misread the relationship.
      this.prisma.sale.aggregate({
        where: { tenantId, customerId: id, status: "posted" },
        _sum: { grandTotal: true },
        _count: true,
      }),
    ]);

    return {
      customer,
      sales,
      prescriptions,
      stats: {
        postedSaleCount: totals._count,
        lifetimeValue: totals._sum.grandTotal?.toFixed(2) ?? "0.00",
        lastPurchaseAt: sales.find((s) => s.status === "posted")?.soldAt ?? null,
      },
    };
  }

  /**
   * Partial update. A customer entered with a typo at the counter used to be
   * permanent — there was no PATCH at all.
   */
  async update(tenantId: string, id: string, dto: UpdateCustomerDto) {
    await this.getOne(tenantId, id);

    const phone = dto.phone === undefined ? undefined : dto.phone?.trim() || null;
    if (phone) {
      const clash = await this.prisma.customer.findFirst({
        where: { tenantId, phone, id: { not: id } },
        select: { id: true, fullName: true },
      });
      if (clash) {
        throw new BadRequestException(
          `Phone ${phone} already belongs to ${clash.fullName}`,
        );
      }
    }

    const mutation = await this.prisma.customer.updateMany({
      where: { id, tenantId },
      data: {
        ...(dto.fullName !== undefined ? { fullName: dto.fullName.trim() } : {}),
        ...(phone !== undefined ? { phone } : {}),
        ...(dto.email !== undefined ? { email: dto.email?.trim() || null } : {}),
        ...(dto.address !== undefined
          ? { address: dto.address?.trim() || null }
          : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes?.trim() || null } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
    assertOneScopedMutation(mutation, "Customer");

    return this.getOne(tenantId, id);
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
