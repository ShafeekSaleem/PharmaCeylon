import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import { Prisma, RoleName } from "@prisma/client";
import { DEFAULT_PHARMACY_APPEARANCE } from "@pharmaceylon/shared";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { TenantAppearanceService } from "./tenant-appearance.service";

const tenantId = "tenant-1";

function user(role: RoleName): RequestUser {
  return {
    userId: "user-1",
    tenantId,
    email: "u@example.com",
    fullName: "U",
    authMethod: "cookie",
    branchRoles: [{ branchId: "branch-1", role }],
  };
}

const owner = user(RoleName.owner);
const manager = user(RoleName.manager);
const updatedAt = new Date("2026-11-19T08:00:00Z");

function stored(overrides: Record<string, unknown> = {}) {
  return {
    ...DEFAULT_PHARMACY_APPEARANCE,
    version: 1,
    updatedAt,
    ...overrides,
  };
}

function setup(existing: ReturnType<typeof stored> | null) {
  let row = existing;
  const tx = {
    tenantAppearance: {
      findUnique: jest.fn(async () => row),
      findUniqueOrThrow: jest.fn(async () => row),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        row = stored({ ...data, version: 1 });
        return row;
      }),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { version: number };
          data: Record<string, unknown>;
        }) => {
          if (!row || row.version !== where.version) return { count: 0 };
          const { version: _v, updatedByUserId: _u, ...rest } = data;
          row = stored({ ...row, ...rest, version: row.version + 1 });
          return { count: 1 };
        },
      ),
    },
  };
  const prisma = {
    tenantAppearance: { findUnique: tx.tenantAppearance.findUnique },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  } as unknown as PrismaService;
  const audit = { log: jest.fn() } as unknown as AuditService;
  return { service: new TenantAppearanceService(prisma, audit), tx, audit };
}

describe("TenantAppearanceService", () => {
  it("returns the PharmaCeylon defaults at version 0 before anyone saves", async () => {
    const { service } = setup(null);
    await expect(service.get(tenantId)).resolves.toEqual({
      ...DEFAULT_PHARMACY_APPEARANCE,
      version: 0,
      updatedAt: null,
    });
  });

  it("lets an owner make the first save and audits it", async () => {
    const { service, tx, audit } = setup(null);
    const saved = await service.update(owner, {
      expectedVersion: 0,
      appearance: {
        ...DEFAULT_PHARMACY_APPEARANCE,
        accent: "#1D5FA8",
        statusSet: "colour-blind",
      },
    });
    expect(saved).toMatchObject({
      accent: "#1d5fa8",
      statusSet: "colour-blind",
      version: 1,
    });
    expect(tx.tenantAppearance.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId,
          accent: "#1d5fa8",
          updatedByUserId: "user-1",
        }),
      }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "tenant.appearance_updated",
        entityId: tenantId,
        payload: expect.objectContaining({
          fromVersion: 0,
          toVersion: 1,
          from: DEFAULT_PHARMACY_APPEARANCE,
          to: expect.objectContaining({ accent: "#1d5fa8" }),
        }),
      }),
      tx,
    );
  });

  it("updates on the version the owner loaded", async () => {
    const { service } = setup(stored({ version: 3 }));
    const saved = await service.update(owner, {
      expectedVersion: 3,
      appearance: { ...DEFAULT_PHARMACY_APPEARANCE, sidebarStyle: "dark" },
    });
    expect(saved).toMatchObject({ sidebarStyle: "dark", version: 4 });
  });

  it("refuses a save based on an older version", async () => {
    const { service, audit } = setup(stored({ version: 3 }));
    await expect(
      service.update(owner, {
        expectedVersion: 2,
        appearance: { ...DEFAULT_PHARMACY_APPEARANCE },
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("treats a first save that loses a race as stale", async () => {
    const { service, tx } = setup(null);
    tx.tenantAppearance.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("dup", {
        code: "P2002",
        clientVersion: "test",
      }),
    );
    await expect(
      service.update(owner, {
        expectedVersion: 0,
        appearance: { ...DEFAULT_PHARMACY_APPEARANCE },
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("refuses anyone but an owner, even with tenant.management", async () => {
    const { service, tx } = setup(null);
    await expect(
      service.update(manager, {
        expectedVersion: 0,
        appearance: { ...DEFAULT_PHARMACY_APPEARANCE },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.tenantAppearance.create).not.toHaveBeenCalled();
  });

  it("refuses an accent that can't be read, with the same words as the form", async () => {
    const { service } = setup(null);
    const attempt = service.update(owner, {
      expectedVersion: 0,
      appearance: { ...DEFAULT_PHARMACY_APPEARANCE, accent: "#0d9488" },
    });
    await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
    await expect(attempt).rejects.toThrow(/Too light to read/);
  });
});
