import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { NotificationCategory, NotificationSeverity, RoleName } from "@prisma/client";
import { UserContextService } from "../auth/user-context.service";
import { UploadsService } from "../uploads/uploads.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { NotificationsService } from "../notifications/notifications.service";
import { BranchRole } from "../security/interfaces/authenticated-request.interface";
import { UpdateTenantProfileDto } from "./dto/update-tenant-profile.dto";
import { CreateBranchDto } from "./dto/create-branch.dto";
import { UpdateBranchDto } from "./dto/update-branch.dto";

/** Owner/manager get a "Branch & Tenant" notification for these — gated on `tenant.management`,
 *  the same admin-only permission every Settings page checks. */
const TENANT_NOTIFICATION_PERMISSION = "tenant.management";

/** Fields a manager (scoped to a branch they hold the manager role on) may change.
 *  Identity (code/name), timezone, and activation are structural/tenant-wide concerns and
 *  stay owner-only (tenant.branches_create-level access) — see TenantService.updateBranch. */
const MANAGER_EDITABLE_BRANCH_FIELDS: readonly (keyof UpdateBranchDto)[] = [
  "city",
  "addressLine1",
  "addressLine2",
  "phone",
  "email",
  "district",
  "postalCode",
  "pharmacyLicenceNo",
  "pharmacyLicenceExpiry",
  "responsiblePharmacist",
  "pharmacistSlmcNo",
  "openingHours",
];

@Injectable()
export class TenantService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly userContext: UserContextService,
    private readonly uploads: UploadsService,
    private readonly notifications: NotificationsService,
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
        logoUrl: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        postalCode: true,
        email: true,
        phone: true,
        taxIdentificationNo: true,
        vatRegistrationNo: true,
      },
    });
  }

  async updateProfile(tenantId: string, actorUserId: string, dto: UpdateTenantProfileDto) {
    const existing = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { logoUrl: true },
    });
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
        ...(dto.logoUrl !== undefined ? { logoUrl: dto.logoUrl } : {}),
        ...(dto.addressLine1 !== undefined ? { addressLine1: dto.addressLine1 } : {}),
        ...(dto.addressLine2 !== undefined ? { addressLine2: dto.addressLine2 } : {}),
        ...(dto.city !== undefined ? { city: dto.city } : {}),
        ...(dto.postalCode !== undefined ? { postalCode: dto.postalCode } : {}),
        ...(dto.email !== undefined ? { email: dto.email } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        ...(dto.taxIdentificationNo !== undefined ? { taxIdentificationNo: dto.taxIdentificationNo } : {}),
        ...(dto.vatRegistrationNo !== undefined ? { vatRegistrationNo: dto.vatRegistrationNo } : {}),
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
        logoUrl: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        postalCode: true,
        email: true,
        phone: true,
        taxIdentificationNo: true,
        vatRegistrationNo: true,
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

    await this.notifications.notifyByPermission(
      tenantId,
      TENANT_NOTIFICATION_PERMISSION,
      NotificationCategory.system,
      {
        title: "Organization profile was updated",
        actionHref: "/settings/tenant-profile",
      },
      actorUserId,
    );

    if (dto.logoUrl !== undefined && existing.logoUrl && existing.logoUrl !== dto.logoUrl) {
      await this.uploads.deleteImage(existing.logoUrl);
    }

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
        addressLine2: true,
        district: true,
        postalCode: true,
        phone: true,
        email: true,
        pharmacyLicenceNo: true,
        pharmacyLicenceExpiry: true,
        responsiblePharmacist: true,
        pharmacistSlmcNo: true,
        openingHours: true,
        timezone: true,
        isActive: true,
      },
      orderBy: { code: "asc" },
    });
  }

  async createBranch(tenantId: string, actorUserId: string, dto: CreateBranchDto) {
    try {
      const actorMappings = await this.prisma.userBranchRole.findMany({
        where: { tenantId, userId: actorUserId },
        select: { role: true, roleId: true },
      });
      const actorMapping =
        actorMappings.find((mapping) => mapping.role === RoleName.owner) ??
        actorMappings.find((mapping) => mapping.role === RoleName.manager) ??
        actorMappings[0];
      if (!actorMapping) {
        throw new BadRequestException("The branch creator must have an assigned role");
      }
      const ownerMappings = await this.prisma.userBranchRole.findMany({
        where: { tenantId, role: RoleName.owner },
        select: { userId: true, roleId: true },
        distinct: ["userId"],
      });
      const grants: Array<{
        tenantId: string;
        userId: string;
        role: RoleName;
        roleId: string | null;
      }> = ownerMappings.map((mapping) => ({
        tenantId,
        userId: mapping.userId,
        role: RoleName.owner,
        roleId: mapping.roleId,
      }));
      if (!grants.some((grant) => grant.userId === actorUserId)) {
        grants.push({
          tenantId,
          userId: actorUserId,
          role: actorMapping.role,
          roleId: actorMapping.roleId,
        });
      }

      const branch = await this.prisma.$transaction(async (tx) => {
        const created = await tx.branch.create({
          data: {
            tenantId,
            code: dto.code.trim(),
            name: dto.name.trim(),
            city: dto.city?.trim() || null,
            addressLine1: dto.addressLine1?.trim() || null,
            addressLine2: dto.addressLine2?.trim() || null,
            phone: dto.phone?.trim() || null,
            email: dto.email?.trim() || null,
            district: dto.district?.trim() || null,
            postalCode: dto.postalCode?.trim() || null,
            pharmacyLicenceNo: dto.pharmacyLicenceNo?.trim() || null,
            pharmacyLicenceExpiry: dto.pharmacyLicenceExpiry ? new Date(dto.pharmacyLicenceExpiry) : null,
            responsiblePharmacist: dto.responsiblePharmacist?.trim() || null,
            pharmacistSlmcNo: dto.pharmacistSlmcNo?.trim() || null,
            openingHours: dto.openingHours?.trim() || null,
            timezone: dto.timezone?.trim() || "Asia/Colombo",
          },
        });
        await tx.userBranchRole.createMany({
          data: grants.map((grant) => ({ ...grant, branchId: created.id })),
          skipDuplicates: true,
        });
        return created;
      });

      for (const grant of grants) this.userContext.invalidate(grant.userId);

      await this.audit.log({
        tenantId,
        actorUserId,
        eventName: "branch.created",
        entityName: "branch",
        entityId: branch.id,
        payload: { code: branch.code, name: branch.name },
      });

      await this.notifications.notifyByPermission(
        tenantId,
        TENANT_NOTIFICATION_PERMISSION,
        NotificationCategory.system,
        {
          title: `New branch "${branch.name}" was created`,
          actionHref: "/settings/branches",
          entityType: "branch",
          entityId: branch.id,
        },
        actorUserId,
      );

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
    actorBranchRoles: BranchRole[],
    branchId: string,
    dto: UpdateBranchDto,
    selectedBranchId?: string,
  ) {
    const existing = await this.prisma.branch.findFirst({ where: { id: branchId, tenantId } });
    if (!existing) throw new NotFoundException("Branch not found");

    // tenant.branches_manage only confirms the caller holds it *somewhere* in the tenant — it
    // isn't branch-scoped. Enforce the finer rule here: owner-anywhere may edit any branch in
    // full; a manager may only edit a branch they hold the manager role on, and only a
    // restricted field set (identity/timezone/activation stay owner-only).
    const isOwnerAnywhere = actorBranchRoles.some((br) => br.role === RoleName.owner);
    if (!isOwnerAnywhere) {
      const managesThisBranch = actorBranchRoles.some(
        (br) => br.branchId === branchId && br.role === RoleName.manager,
      );
      if (!managesThisBranch) {
        throw new ForbiddenException("You can only edit a branch where you are the manager");
      }
      // class-transformer's ValidationPipe populates every UpdateBranchDto field as an own key
      // (undefined when the client didn't send it) — filter those out first, or every request
      // would appear to "touch" every field regardless of what was actually sent.
      const disallowedFields = Object.keys(dto).filter(
        (key) =>
          dto[key as keyof UpdateBranchDto] !== undefined &&
          !MANAGER_EDITABLE_BRANCH_FIELDS.includes(key as keyof UpdateBranchDto),
      );
      if (disallowedFields.length > 0) {
        throw new ForbiddenException(
          `Managers cannot change: ${disallowedFields.join(", ")} — only an owner can`,
        );
      }
    }

    if (existing.isActive && dto.isActive === false) {
      if (selectedBranchId === branchId) {
        throw new BadRequestException("Switch to another branch before deactivating this branch");
      }
      const activeCount = await this.prisma.branch.count({ where: { tenantId, isActive: true } });
      if (activeCount <= 1) {
        throw new BadRequestException("The last active branch cannot be deactivated");
      }
    }

    try {
      const branch = await this.prisma.branch.update({
        where: { id: branchId, tenantId },
        data: {
          ...(dto.code != null ? { code: dto.code.trim() } : {}),
          ...(dto.name != null ? { name: dto.name.trim() } : {}),
          ...(dto.city !== undefined ? { city: dto.city?.trim() || null } : {}),
          ...(dto.addressLine1 !== undefined ? { addressLine1: dto.addressLine1?.trim() || null } : {}),
          ...(dto.addressLine2 !== undefined ? { addressLine2: dto.addressLine2?.trim() || null } : {}),
          ...(dto.district !== undefined ? { district: dto.district?.trim() || null } : {}),
          ...(dto.postalCode !== undefined ? { postalCode: dto.postalCode?.trim() || null } : {}),
          ...(dto.phone !== undefined ? { phone: dto.phone?.trim() || null } : {}),
          ...(dto.email !== undefined ? { email: dto.email?.trim() || null } : {}),
          ...(dto.pharmacyLicenceNo !== undefined ? { pharmacyLicenceNo: dto.pharmacyLicenceNo?.trim() || null } : {}),
          ...(dto.pharmacyLicenceExpiry !== undefined
            ? { pharmacyLicenceExpiry: dto.pharmacyLicenceExpiry ? new Date(dto.pharmacyLicenceExpiry) : null }
            : {}),
          ...(dto.responsiblePharmacist !== undefined ? { responsiblePharmacist: dto.responsiblePharmacist?.trim() || null } : {}),
          ...(dto.pharmacistSlmcNo !== undefined ? { pharmacistSlmcNo: dto.pharmacistSlmcNo?.trim() || null } : {}),
          ...(dto.openingHours !== undefined ? { openingHours: dto.openingHours?.trim() || null } : {}),
          ...(dto.timezone != null ? { timezone: dto.timezone.trim() } : {}),
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

      await this.notifications.notifyByPermission(
        tenantId,
        TENANT_NOTIFICATION_PERMISSION,
        NotificationCategory.system,
        {
          severity: dto.isActive === false ? NotificationSeverity.warning : NotificationSeverity.info,
          title:
            dto.isActive === false
              ? `Branch "${branch.name}" was deactivated`
              : `Branch "${branch.name}" was updated`,
          actionHref: "/settings/branches",
          entityType: "branch",
          entityId: branch.id,
        },
        actorUserId,
      );

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
