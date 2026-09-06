import { NotFoundException, UnauthorizedException } from "@nestjs/common";
import { RoleName } from "@prisma/client";
import * as bcrypt from "bcrypt";
import { StaffInvitationsService } from "./staff-invitations.service";

jest.mock("bcrypt");
const mockedBcrypt = bcrypt as jest.Mocked<typeof bcrypt>;

describe("StaffInvitationsService", () => {
  const tenantId = "00000000-0000-4000-8000-000000000001";
  const actorId = "00000000-0000-4000-8000-000000000002";
  const branchId = "00000000-0000-4000-8000-000000000003";
  const userId = "00000000-0000-4000-8000-000000000004";

  function makeService() {
    const prisma: any = {
      tenantMembership: {
        findFirst: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
      },
      staffInvitation: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      branch: { findMany: jest.fn().mockResolvedValue([{ id: branchId }]) },
      role: {
        findUnique: jest.fn().mockResolvedValue({ id: "role-cashier" }),
        findFirst: jest.fn(),
      },
      appUser: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      userBranchRole: { upsert: jest.fn().mockResolvedValue({}) },
      notificationPreference: { upsert: jest.fn().mockResolvedValue({}) },
    };
    prisma.$transaction = jest.fn((callback: (tx: unknown) => Promise<unknown>) => callback(prisma));
    const email = { sendStaffInvitation: jest.fn().mockResolvedValue(undefined) };
    const auth = { issueTenantSession: jest.fn().mockResolvedValue({ user: { id: userId } }) };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    return {
      prisma,
      email,
      auth,
      audit,
      service: new StaffInvitationsService(prisma, email as never, auth as never, audit as never),
    };
  }

  const usableInvitation = () => ({
    id: "00000000-0000-4000-8000-000000000010",
    tenantId,
    email: "cashier@example.com",
    fullName: "Kamal Silva",
    expiresAt: new Date(Date.now() + 60_000),
    acceptedAt: null,
    revokedAt: null,
    tenant: { displayName: "Royal Pharmacy", isActive: true },
    invitedBy: { fullName: "Asha Perera" },
    roles: [{
      branchId,
      role: RoleName.cashier,
      roleId: "role-cashier",
      branch: { name: "Main Branch", isActive: true },
      roleRef: { name: "Cashier" },
    }],
  });

  it("creates an expiring, hashed invitation and sends the raw link by email", async () => {
    const { service, prisma, email } = makeService();
    prisma.staffInvitation.create.mockImplementation(({ data }: any) => Promise.resolve({
      id: "invite-1",
      email: data.email,
      fullName: data.fullName,
      expiresAt: data.expiresAt,
      tokenHash: data.tokenHash,
      tenant: { displayName: "Royal Pharmacy" },
      invitedBy: { fullName: "Asha Perera" },
    }));

    await service.create(tenantId, actorId, true, {
      email: "Cashier@Example.com",
      fullName: "Kamal Silva",
      assignments: [{ branchId, role: RoleName.cashier }],
    });

    const stored = prisma.staffInvitation.create.mock.calls[0][0].data;
    const sent = email.sendStaffInvitation.mock.calls[0][0];
    expect(stored.email).toBe("cashier@example.com");
    expect(stored.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(sent.token).toBeTruthy();
    expect(sent.token).not.toBe(stored.tokenHash);
  });

  it("rejects an assignment whose branch is outside the inviter's tenant", async () => {
    const { service, prisma } = makeService();
    prisma.branch.findMany.mockResolvedValue([]);
    await expect(service.create(tenantId, actorId, true, {
      email: "cashier@example.com",
      fullName: "Kamal Silva",
      assignments: [{ branchId, role: RoleName.cashier }],
    })).rejects.toBeInstanceOf(NotFoundException);
  });

  it("accepts an invitation for an existing identity and issues a session in the invited tenant", async () => {
    const { service, prisma, auth } = makeService();
    prisma.staffInvitation.findUnique.mockResolvedValue(usableInvitation());
    prisma.appUser.findUnique.mockResolvedValue({ id: userId, passwordHash: "hash", isActive: true });
    mockedBcrypt.compare.mockResolvedValue(true as never);

    await service.accept("a-valid-invitation-token-value", { password: "secret123" });

    expect(prisma.tenantMembership.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId_userId: { tenantId, userId } },
    }));
    expect(prisma.userBranchRole.upsert).toHaveBeenCalled();
    expect(auth.issueTenantSession).toHaveBeenCalledWith(userId, tenantId, {});
  });

  it("does not attach access when an existing account password is wrong", async () => {
    const { service, prisma } = makeService();
    prisma.staffInvitation.findUnique.mockResolvedValue(usableInvitation());
    prisma.appUser.findUnique.mockResolvedValue({ id: userId, passwordHash: "hash", isActive: true });
    mockedBcrypt.compare.mockResolvedValue(false as never);

    await expect(
      service.accept("a-valid-invitation-token-value", { password: "wrongpass" }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
