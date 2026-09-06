import {
  BadRequestException,
  ConflictException,
  Injectable,
} from "@nestjs/common";
import { OwnerRegistrationStatus, Prisma, RoleName } from "@prisma/client";
import { CategoryTaxonomyService } from "../catalog/category-taxonomy.service";
import { PrismaService } from "../prisma/prisma.service";
import {
  BUILT_IN_ROLES,
  BUILT_IN_ROLE_LABELS,
  PERMISSION_CATALOG,
  defaultPermissionsForRole,
} from "../security/permission-catalog";
import {
  OnboardingDraft,
  OnboardingDraftService,
} from "./onboarding-draft.service";
import { VerifiedOwnerSession } from "./owner-registration.service";

type ProvisionedWorkspace = {
  tenantId: string;
  branchId: string;
  userId: string;
  tenantName: string;
  branchName: string;
  alreadyCompleted: boolean;
};

@Injectable()
export class WorkspaceProvisioningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly drafts: OnboardingDraftService,
    private readonly taxonomy: CategoryTaxonomyService,
  ) {}

  async complete(owner: VerifiedOwnerSession): Promise<ProvisionedWorkspace> {
    if (owner.status === "completed") {
      const existing = await this.findCompleted(owner);
      await this.taxonomy.ensureCommercialTemplate(existing.tenantId);
      // Resume path: the department selection is applied here too, so a completion that
      // failed after the transaction still ends up with the right departments enabled.
      const { draft: savedDraft } = await this.drafts.get(owner.registrationId);
      await this.taxonomy.applyOnboardingSelection(
        existing.tenantId,
        savedDraft.sellsDepartments ?? [],
      );
      return { ...existing, alreadyCompleted: true };
    }

    const { draft } = await this.drafts.get(owner.registrationId);
    validateDraft(draft);

    let result: ProvisionedWorkspace | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        result = await this.prisma.$transaction(
          async (tx) => this.createInTransaction(tx, owner, draft),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        break;
      } catch (error) {
        if (isSerializationFailure(error) && attempt < 2) continue;
        throw error;
      }
    }
    if (!result) throw new ConflictException("Unable to create workspace");

    // Idempotent tenant template setup. If this fails, retrying the completion
    // endpoint resumes from the completed registration and safely retries it.
    await this.taxonomy.ensureCommercialTemplate(result.tenantId);
    // Turn on the departments the pharmacy said it sells. Only Medicines is enabled by
    // default, so without this a shop stocking shampoo and nappies has to go and find
    // Settings → Catalog → Categories before it can file a single product.
    await this.taxonomy.applyOnboardingSelection(
      result.tenantId,
      draft.sellsDepartments ?? [],
    );
    return result;
  }

  private async createInTransaction(
    tx: Prisma.TransactionClient,
    owner: VerifiedOwnerSession,
    draft: OnboardingDraft,
  ): Promise<ProvisionedWorkspace> {
    const registration = await tx.ownerRegistration.findUnique({
      where: { id: owner.registrationId },
    });
    if (!registration)
      throw new BadRequestException("Owner registration not found");
    if (
      registration.status === OwnerRegistrationStatus.completed &&
      registration.completedTenantId &&
      registration.completedUserId
    ) {
      const completed = await this.findCompletedInTransaction(
        tx,
        registration.completedTenantId,
        registration.completedUserId,
      );
      return { ...completed, alreadyCompleted: true };
    }
    if (registration.status !== OwnerRegistrationStatus.verified) {
      throw new ConflictException(
        "Owner registration is not ready for workspace creation",
      );
    }

    const duplicateUser = await tx.appUser.findUnique({
      where: { email: registration.email },
      select: { id: true },
    });
    if (duplicateUser) {
      throw new ConflictException(
        "An account already exists for this email address",
      );
    }

    const tenant = await tx.tenant.create({
      data: {
        code: tenantCode(draft.businessName!, registration.id),
        displayName: draft.businessName!.trim(),
        legalName: draft.legalName?.trim() || draft.businessName!.trim(),
        complianceRegion: (draft.country ?? "LK").toUpperCase(),
        timezone: draft.timezone ?? "Asia/Colombo",
        currency: draft.currency ?? "LKR",
        dateFormat: draft.dateFormat ?? "DD/MM/YYYY",
        logoUrl: draft.businessLogoUrl ?? null,
        email: draft.businessEmail?.trim().toLowerCase() || registration.email,
        phone: joinPhone(draft.businessPhoneCountryCode, draft.businessPhone),
      },
    });

    const branch = await tx.branch.create({
      data: {
        tenantId: tenant.id,
        code: branchCode(draft.branchCode, draft.branchName!),
        name: draft.branchName!.trim(),
        timezone: draft.branchTimezone ?? draft.timezone ?? "Asia/Colombo",
        addressLine1: draft.addressLine1!.trim(),
        city: draft.city?.trim() || null,
        district: draft.district?.trim() || draft.province?.trim() || null,
        postalCode: draft.postalCode?.trim() || null,
        phone:
          draft.useBusinessPhone === false
            ? joinPhone(draft.branchPhoneCountryCode, draft.branchPhone)
            : joinPhone(draft.businessPhoneCountryCode, draft.businessPhone),
        email: draft.businessEmail?.trim().toLowerCase() || registration.email,
        setupRequired: true,
        setupMode: draft.migrationMode ?? "fresh",
      },
    });

    await tx.tenantSettings.create({
      data: {
        tenantId: tenant.id,
        posDefaultPaymentMethod: draft.paymentMethods?.[0] ?? "cash",
        receiptHeaderText:
          draft.receiptDisplayName?.trim() || tenant.displayName,
      },
    });

    for (const permission of PERMISSION_CATALOG) {
      await tx.permission.upsert({
        where: { key: permission.key },
        update: {
          module: permission.module,
          label: permission.label,
          description: permission.description,
        },
        create: {
          key: permission.key,
          module: permission.module,
          label: permission.label,
          description: permission.description,
        },
      });
    }

    let ownerRoleId = "";
    for (const role of BUILT_IN_ROLES) {
      const roleRow = await tx.role.create({
        data: {
          tenantId: tenant.id,
          key: role,
          name: BUILT_IN_ROLE_LABELS[role],
          isSystem: true,
          isLocked: role === RoleName.owner,
        },
      });
      if (role === RoleName.owner) ownerRoleId = roleRow.id;
      await tx.rolePermission.createMany({
        data: defaultPermissionsForRole(role).map((permissionKey) => ({
          tenantId: tenant.id,
          roleId: roleRow.id,
          permissionKey,
        })),
      });
    }

    const user = await tx.appUser.create({
      data: {
        tenantId: tenant.id,
        email: registration.email,
        fullName: `${registration.firstName} ${registration.lastName}`.trim(),
        phone: registration.phone,
        passwordHash: registration.passwordHash,
      },
    });
    await tx.tenantMembership.create({
      data: {
        tenantId: tenant.id,
        userId: user.id,
      },
    });
    await tx.userBranchRole.create({
      data: {
        tenantId: tenant.id,
        branchId: branch.id,
        userId: user.id,
        role: RoleName.owner,
        roleId: ownerRoleId,
      },
    });
    await tx.notificationPreference.create({
      data: { tenantId: tenant.id, userId: user.id },
    });
    await tx.auditEvent.create({
      data: {
        tenantId: tenant.id,
        branchId: branch.id,
        actorUserId: user.id,
        eventName: "onboarding.workspace_created",
        entityName: "tenant",
        entityId: tenant.id,
        payload: {
          registrationId: registration.id,
          setupMode: draft.migrationMode ?? "fresh",
        },
      },
    });
    await tx.ownerRegistration.update({
      where: { id: registration.id },
      data: {
        status: OwnerRegistrationStatus.completed,
        completedTenantId: tenant.id,
        completedUserId: user.id,
        completedAt: new Date(),
      },
    });

    return {
      tenantId: tenant.id,
      branchId: branch.id,
      userId: user.id,
      tenantName: tenant.displayName,
      branchName: branch.name,
      alreadyCompleted: false,
    };
  }

  private async findCompleted(
    owner: VerifiedOwnerSession,
  ): Promise<Omit<ProvisionedWorkspace, "alreadyCompleted">> {
    if (!owner.completedTenantId || !owner.completedUserId) {
      throw new ConflictException(
        "Completed registration is missing workspace references",
      );
    }
    return this.findCompletedInTransaction(
      this.prisma,
      owner.completedTenantId,
      owner.completedUserId,
    );
  }

  private async findCompletedInTransaction(
    db: Pick<PrismaService, "tenant" | "branch"> | Prisma.TransactionClient,
    tenantId: string,
    userId: string,
  ): Promise<Omit<ProvisionedWorkspace, "alreadyCompleted">> {
    const [tenant, branch] = await Promise.all([
      db.tenant.findUnique({
        where: { id: tenantId },
        select: { displayName: true },
      }),
      db.branch.findFirst({
        where: {
          tenantId,
          userBranchRoles: { some: { userId, role: RoleName.owner } },
        },
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true },
      }),
    ]);
    if (!tenant || !branch)
      throw new ConflictException("Completed workspace could not be restored");
    return {
      tenantId,
      branchId: branch.id,
      userId,
      tenantName: tenant.displayName,
      branchName: branch.name,
    };
  }
}

function validateDraft(draft: OnboardingDraft): void {
  const missing = [
    [draft.businessName, "business name"],
    [draft.country, "country"],
    [draft.currency, "currency"],
    [draft.timezone, "time zone"],
    [draft.branchName, "branch name"],
    [draft.addressLine1, "branch address"],
  ].filter(([value]) => typeof value !== "string" || !value.trim());
  if (missing.length) {
    throw new BadRequestException(
      `Complete the following setup fields: ${missing.map(([, label]) => label).join(", ")}`,
    );
  }
  if (!draft.paymentMethods?.length) {
    throw new BadRequestException("Select at least one payment method");
  }
}

function tenantCode(name: string, registrationId: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32) || "pharmacy";
  return `${slug}-${registrationId.replace(/-/g, "").slice(0, 8)}`;
}

function branchCode(value: string | undefined, name: string): string {
  const normalized = value
    ?.trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "");
  if (normalized) return normalized.slice(0, 24);
  const initials = name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return `${initials || "MAIN"}-01`.slice(0, 24);
}

function joinPhone(code?: string, number?: string): string | null {
  const local = number?.trim();
  if (!local) return null;
  return `${code?.trim() ?? ""} ${local}`.trim();
}

function isSerializationFailure(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2034"
  );
}
