import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { nextDocumentNumber } from "../common/document-sequence.util";
import { PrismaService } from "../prisma/prisma.service";
import { CreatePrescriptionDto } from "./dto/create-prescription.dto";

const PRESCRIPTION_SELECT = {
  id: true,
  rxNumber: true,
  patientName: true,
  doctorName: true,
  doctorRegNo: true,
  issuedOn: true,
  validUntil: true,
  notes: true,
  customerId: true,
  createdAt: true,
  customer: { select: { id: true, fullName: true, phone: true } },
} satisfies Prisma.PrescriptionSelect;

/** Parse a `YYYY-MM-DD` (or ISO) string into a UTC calendar date. */
function toUtcDate(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`Invalid date: ${value}`);
  }
  return new Date(
    Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()),
  );
}

@Injectable()
export class PrescriptionsService {
  constructor(private readonly prisma: PrismaService) {}

  async search(
    tenantId: string,
    branchId: string,
    options: { q?: string; customerId?: string; take?: number } = {},
  ) {
    const term = options.q?.trim();
    return this.prisma.prescription.findMany({
      where: {
        tenantId,
        branchId,
        ...(options.customerId ? { customerId: options.customerId } : {}),
        ...(term
          ? {
              OR: [
                { rxNumber: { contains: term, mode: "insensitive" } },
                { patientName: { contains: term, mode: "insensitive" } },
                { doctorName: { contains: term, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      select: PRESCRIPTION_SELECT,
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(options.take ?? 20, 1), 50),
    });
  }

  async getOne(tenantId: string, branchId: string, id: string) {
    const rx = await this.prisma.prescription.findFirst({
      where: { id, tenantId, branchId },
      select: PRESCRIPTION_SELECT,
    });
    if (!rx) throw new NotFoundException("Prescription not found");
    return rx;
  }

  async create(
    tenantId: string,
    branchId: string,
    userId: string,
    dto: CreatePrescriptionDto,
  ) {
    const issuedOn = toUtcDate(dto.issuedOn);
    const validUntil = dto.validUntil ? toUtcDate(dto.validUntil) : null;
    if (validUntil && validUntil < issuedOn) {
      throw new BadRequestException("Valid-until cannot be before the issue date");
    }

    if (dto.customerId) {
      const customer = await this.prisma.customer.findFirst({
        where: { id: dto.customerId, tenantId },
        select: { id: true },
      });
      if (!customer) throw new BadRequestException("Customer not found");
    }

    return this.prisma.$transaction(async (tx) => {
      const rxNumber =
        dto.rxNumber?.trim() ||
        (await nextDocumentNumber(tx, tenantId, branchId, "prescription", "RX-"));

      const clash = await tx.prescription.findFirst({
        where: { tenantId, branchId, rxNumber },
        select: { id: true },
      });
      if (clash) {
        throw new BadRequestException(`Prescription ${rxNumber} already exists`);
      }

      return tx.prescription.create({
        data: {
          tenantId,
          branchId,
          rxNumber,
          patientName: dto.patientName.trim(),
          doctorName: dto.doctorName.trim(),
          doctorRegNo: dto.doctorRegNo?.trim() || null,
          issuedOn,
          validUntil,
          notes: dto.notes?.trim() || null,
          customerId: dto.customerId ?? null,
          createdBy: userId,
        },
        select: PRESCRIPTION_SELECT,
      });
    });
  }
}
