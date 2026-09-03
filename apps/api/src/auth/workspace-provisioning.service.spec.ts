import { OwnerRegistrationStatus, RoleName } from "@prisma/client";
import { WorkspaceProvisioningService } from "./workspace-provisioning.service";

describe("WorkspaceProvisioningService", () => {
  const registrationId = "00000000-0000-4000-8000-000000000001";
  const tenantId = "00000000-0000-4000-8000-000000000002";
  const branchId = "00000000-0000-4000-8000-000000000003";
  const userId = "00000000-0000-4000-8000-000000000004";

  const owner = {
    registrationId,
    email: "owner@example.com",
    firstName: "Asha",
    lastName: "Perera",
    phone: "+94 771234567",
    status: "verified" as const,
    completedTenantId: null,
    completedUserId: null,
    nextPath: "/onboarding/pharmacy" as const,
  };

  const draft = {
    currentStep: 4,
    businessName: "Royal Pharmacy",
    legalName: "Royal Pharmacy (Pvt) Ltd",
    country: "LK",
    currency: "LKR",
    timezone: "Asia/Colombo",
    businessEmail: "hello@royal.lk",
    businessPhoneCountryCode: "+94",
    businessPhone: "112345678",
    branchName: "Matale Main",
    branchCode: "MAT-01",
    addressLine1: "1 Main Street",
    city: "Matale",
    district: "Matale",
    branchTimezone: "Asia/Colombo",
    migrationMode: "migrating" as const,
    sellsDepartments: ["Personal Care", "Baby & Mother Care"],
    receiptDisplayName: "Royal Pharmacy",
    paymentMethods: ["cash", "card"],
  };

  it("creates the workspace, owner access and defaults in one transaction", async () => {
    const tx = {
      ownerRegistration: {
        findUnique: jest.fn().mockResolvedValue({
          id: registrationId,
          email: owner.email,
          firstName: owner.firstName,
          lastName: owner.lastName,
          phone: owner.phone,
          passwordHash: "password-hash",
          status: OwnerRegistrationStatus.verified,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      appUser: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: userId }),
      },
      tenant: {
        create: jest.fn().mockResolvedValue({
          id: tenantId,
          displayName: draft.businessName,
        }),
      },
      branch: {
        create: jest.fn().mockResolvedValue({ id: branchId, name: draft.branchName }),
      },
      tenantSettings: { create: jest.fn().mockResolvedValue({}) },
      permission: { upsert: jest.fn().mockResolvedValue({}) },
      role: {
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({ id: `role-${data.key}`, key: data.key }),
        ),
      },
      rolePermission: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
      userBranchRole: { create: jest.fn().mockResolvedValue({}) },
      notificationPreference: { create: jest.fn().mockResolvedValue({}) },
      auditEvent: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: jest.fn((callback) => callback(tx)),
    };
    const drafts = { get: jest.fn().mockResolvedValue({ draft }) };
    const taxonomy = {
      ensureCommercialTemplate: jest.fn().mockResolvedValue(undefined),
      applyOnboardingSelection: jest.fn().mockResolvedValue(undefined),
    };
    const service = new WorkspaceProvisioningService(
      prisma as never,
      drafts as never,
      taxonomy as never,
    );

    const result = await service.complete(owner);

    expect(result).toEqual(
      expect.objectContaining({ tenantId, branchId, userId, alreadyCompleted: false }),
    );
    expect(tx.branch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ setupRequired: true, setupMode: "migrating" }),
      }),
    );
    expect(tx.userBranchRole.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ role: RoleName.owner, roleId: "role-owner" }),
      }),
    );
    expect(tx.ownerRegistration.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: OwnerRegistrationStatus.completed }),
      }),
    );
    expect(taxonomy.ensureCommercialTemplate).toHaveBeenCalledWith(tenantId);
    // The wizard's "what does your pharmacy sell" answer has to reach provisioning, or the
    // toggles are just a form that does nothing.
    expect(taxonomy.applyOnboardingSelection).toHaveBeenCalledWith(
      tenantId,
      draft.sellsDepartments ?? [],
    );
  });

  it("resumes an already-completed registration without creating duplicates", async () => {
    const prisma = {
      tenant: {
        findUnique: jest.fn().mockResolvedValue({ displayName: "Royal Pharmacy" }),
      },
      branch: {
        findFirst: jest.fn().mockResolvedValue({ id: branchId, name: "Matale Main" }),
      },
      $transaction: jest.fn(),
    };
    const taxonomy = {
      ensureCommercialTemplate: jest.fn().mockResolvedValue(undefined),
      applyOnboardingSelection: jest.fn().mockResolvedValue(undefined),
    };
    const drafts = {
      get: jest.fn().mockResolvedValue({
        draft: { sellsDepartments: ["Personal Care"] },
      }),
    };
    const service = new WorkspaceProvisioningService(
      prisma as never,
      drafts as never,
      taxonomy as never,
    );

    const result = await service.complete({
      ...owner,
      status: "completed",
      completedTenantId: tenantId,
      completedUserId: userId,
      nextPath: "/get-started",
    });

    expect(result.alreadyCompleted).toBe(true);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(taxonomy.ensureCommercialTemplate).toHaveBeenCalledWith(tenantId);
    // Resuming re-applies the department selection, so a completion that died after the
    // transaction still lands with the right departments switched on.
    expect(taxonomy.applyOnboardingSelection).toHaveBeenCalledWith(tenantId, [
      "Personal Care",
    ]);
  });
});
