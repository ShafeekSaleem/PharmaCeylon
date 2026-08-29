import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { UpdateTenantProfileDto } from "./dto/update-tenant-profile.dto";
import { CreateBranchDto } from "./dto/create-branch.dto";
import { UpdateBranchDto } from "./dto/update-branch.dto";

@Injectable()
export class TenantService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async getProfile(tenantId: string) {
    return this.prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: {
        code: true,
        displayName: true,
        legalName: true,
        complianceRegion: true,
        timezone: true,
        currency: true,
        dateFormat: true,
        fiscalYearStartMonth: true,
        businessRegistrationNo: true,
      },
    });
  }

  async updateProfile(tenantId: string, actorUserId: string, dto: UpdateTenantProfileDto) {
    const tenant = await this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        ...(dto.displayName != null ? { displayName: dto.displayName } : {}),
        ...(dto.legalName != null ? { legalName: dto.legalName } : {}),
        ...(dto.complianceRegion != null ? { complianceRegion: dto.complianceRegion } : {}),
        ...(dto.currency != null ? { currency: dto.currency } : {}),
        ...(dto.dateFormat != null ? { dateFormat: dto.dateFormat } : {}),
        ...(dto.fiscalYearStartMonth != null
          ? { fiscalYearStartMonth: dto.fiscalYearStartMonth }
          : {}),
        ...(dto.businessRegistrationNo !== undefined
          ? { businessRegistrationNo: dto.businessRegistrationNo }
          : {}),
      },
      select: {
        code: true,
        displayName: true,
        legalName: true,
        complianceRegion: true,
        timezone: true,
        currency: true,
        dateFormat: true,
        fiscalYearStartMonth: true,
        businessRegistrationNo: true,
      },
    });

    await this.audit.log({
      tenantId,
      actorUserId,
      eventName: "tenant.profile_updated",
      entityName: "tenant",
      entityId: tenantId,
      payload: { ...dto },
    });

    return tenant;
  }

  /** Every branch regardless of isActive, unscoped by the caller's own branchRoles — an owner
   *  managing branches needs to see (and reactivate) inactive ones and branches they have no
   *  personal UserBranchRole on. Distinct from the self-scoped, active-only GET /tenant/branches
   *  used for branch-switching. */
  async listAllBranches(tenantId: string) {
    return this.prisma.branch.findMany({
      where: { tenantId },
      select: {
        id: true,
        code: true,
        name: true,
        city: true,
        addressLine1: true,
        phone: true,
        timezone: true,
        isActive: true,
      },
      orderBy: { code: "asc" },
    });
  }

  async createBranch(tenantId: string, actorUserId: string, dto: CreateBranchDto) {
    try {
      const branch = await this.prisma.branch.create({
        data: {
          tenantId,
          code: dto.code.trim(),
          name: dto.name.trim(),
          city: dto.city,
          addressLine1: dto.addressLine1,
          phone: dto.phone,
          timezone: dto.timezone ?? "Asia/Colombo",
        },
      });

      await this.audit.log({
        tenantId,
        actorUserId,
        eventName: "branch.created",
        entityName: "branch",
        entityId: branch.id,
        payload: { code: branch.code, name: branch.name },
      });

      return branch;
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code;
      if (code === "P2002") {
        throw new ConflictException("A branch with this code already exists");
      }
      throw e;
    }
  }

  async updateBranch(
    tenantId: string,
    actorUserId: string,
    branchId: string,
    dto: UpdateBranchDto,
  ) {
    const existing = await this.prisma.branch.findFirst({ where: { id: branchId, tenantId } });
    if (!existing) throw new NotFoundException("Branch not found");

    try {
      const branch = await this.prisma.branch.update({
        where: { id: branchId, tenantId },
        data: {
          ...(dto.code != null ? { code: dto.code.trim() } : {}),
          ...(dto.name != null ? { name: dto.name.trim() } : {}),
          ...(dto.city !== undefined ? { city: dto.city } : {}),
          ...(dto.addressLine1 !== undefined ? { addressLine1: dto.addressLine1 } : {}),
          ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
          ...(dto.timezone != null ? { timezone: dto.timezone } : {}),
          ...(dto.isActive != null ? { isActive: dto.isActive } : {}),
        },
      });

      await this.audit.log({
        tenantId,
        actorUserId,
        eventName: "branch.updated",
        entityName: "branch",
        entityId: branch.id,
        payload: { ...dto },
      });

      return branch;
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code;
      if (code === "P2002") {
        throw new ConflictException("A branch with this code already exists");
      }
      throw e;
    }
  }
}
