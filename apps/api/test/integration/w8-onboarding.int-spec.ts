import { randomBytes, randomUUID } from "node:crypto";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { WEEKDAYS } from "@pharmaceylon/shared";
import { OnboardingDraftService } from "../../src/auth/onboarding-draft.service";
import { WorkspaceProvisioningService } from "../../src/auth/workspace-provisioning.service";
import { AuditService } from "../../src/audit/audit.service";
import { SetupReadinessService } from "../../src/setup/setup-readiness.service";
import { createPrisma } from "./fixtures";

const prisma = createPrisma();
const hours = {
  schemaVersion: 1,
  weekly: Object.fromEntries(
    WEEKDAYS.map((day) => [day, { mode: "open_24h" }]),
  ),
  exceptions: [
    {
      date: "2026-12-25",
      label: "Owner-confirmed closure",
      hours: { mode: "closed" },
      source: "owner",
      holidayKey: null,
    },
  ],
  mandatory: null,
};
const drafts = new OnboardingDraftService(prisma as never);
const provisioning = new WorkspaceProvisioningService(prisma as never, drafts, {
  ensureCommercialTemplate: async () => {},
  applyOnboardingSelection: async () => {},
} as never);
const readiness = new SetupReadinessService(
  prisma as never,
  new AuditService(prisma as never),
  {
    coverage: async () => ({
      ranged: 0,
      categorized: 0,
      unplaced: 0,
      percent: 100,
    }),
  } as never,
);

async function registration() {
  const saved = await prisma.ownerRegistration.create({
    data: {
      email: `w8-${randomUUID()}@it.test`,
      firstName: "Owner",
      lastName: "Test",
      passwordHash: "not-used",
      status: "verified",
      verifiedAt: new Date(),
    },
  });
  const owner = {
    registrationId: saved.id,
    email: saved.email,
    firstName: saved.firstName,
    lastName: saved.lastName,
    phone: null,
    status: "verified" as const,
    completedTenantId: null,
    completedUserId: null,
    nextPath: "/onboarding/pharmacy" as const,
  };
  await drafts.save(saved.id, {
    currentStep: 4,
    businessName: "W8 pharmacy",
    country: "LK",
    currency: "LKR",
    timezone: "Asia/Colombo",
    branchName: "Main",
    addressLine1: "1 Test Street",
    paymentMethods: ["cash"],
    branchHours: hours,
    plannedCounterCount: 3,
  });
  return owner;
}
afterAll(() => prisma.$disconnect());

it("provisions structured hours and a planning preference atomically without stock or enrollment effects", async () => {
  const owner = await registration();
  const result = await provisioning.complete(owner);
  const branch = await prisma.branch.findUniqueOrThrow({
    where: { id: result.branchId },
  });
  expect(branch).toMatchObject({
    operatingHours: hours,
    operatingHoursOrigin: "editor",
    operatingHoursUpdatedBy: result.userId,
    plannedCounterCount: 3,
    desktopPosRollout: "not_live",
    setupRequired: true,
  });
  expect(
    await prisma.stockLedger.count({ where: { tenantId: result.tenantId } }),
  ).toBe(0);
  expect(
    await prisma.batch.count({ where: { tenantId: result.tenantId } }),
  ).toBe(0);
  expect(
    await prisma.terminalEnrollment.count({
      where: { tenantId: result.tenantId },
    }),
  ).toBe(0);
  const replay = await provisioning.complete(owner);
  expect(replay.tenantId).toBe(result.tenantId);
  expect(replay.branchId).toBe(result.branchId);
});

it("completes live checkout readiness only from an active enrollment, never a plan or an old web confirmation", async () => {
  const owner = await registration();
  const result = await provisioning.complete(owner);
  await prisma.branch.update({
    where: { id: result.branchId },
    data: {
      desktopPosRollout: "live",
      desktopPosLiveAt: new Date(),
      checkoutPreparedAt: new Date(),
      salesSettingsReviewedAt: new Date(),
    },
  });
  const terminal = await prisma.operationalTerminal.create({
    data: {
      tenantId: result.tenantId,
      branchId: result.branchId,
      label: "W8 test counter",
    },
  });
  const enrollment = await prisma.terminalEnrollment.create({
    data: {
      tenantId: result.tenantId,
      branchId: result.branchId,
      terminalId: terminal.id,
      keyId: randomUUID(),
      publicKeyHex: randomBytes(32).toString("hex"),
      enrolledByUserId: result.userId,
    },
  });
  const checkoutTask = (data: Awaited<ReturnType<typeof readiness.get>>) =>
    data.tasks.find((task) => task.key === "checkout");
  let data = await readiness.get(result.tenantId, result.branchId);
  expect(data.readyForSales).toBe(false);
  expect(checkoutTask(data)?.complete).toBe(true);
  expect(data.desktopSetup).toEqual({
    enrolledCounters: 1,
    staffPrepared: false,
    testReceipt: false,
  });
  await expect(
    readiness.confirm(
      result.tenantId,
      result.branchId,
      result.userId,
      "checkout",
    ),
  ).rejects.toBeInstanceOf(ConflictException);
  await prisma.terminalEnrollment.update({
    where: { id: enrollment.id },
    data: { revokedAt: new Date(), revocationReason: "Test retired" },
  });
  data = await readiness.get(result.tenantId, result.branchId);
  expect(data.desktopSetup?.enrolledCounters).toBe(0);
  expect(checkoutTask(data)?.complete).toBe(false);
  expect(data.branch.plannedCounterCount).toBe(3);
});

it("refuses hard-limit injection before creating any workspace", async () => {
  const owner = await registration();
  await prisma.ownerRegistration.update({
    where: { id: owner.registrationId },
    data: {
      onboardingDraft: {
        currentStep: 4,
        businessName: "Unsafe",
        country: "LK",
        currency: "LKR",
        timezone: "Asia/Colombo",
        branchName: "Main",
        addressLine1: "1 Street",
        paymentMethods: ["cash"],
        branchHours: { ...hours, mandatory: [] },
      },
    },
  });
  await expect(provisioning.complete(owner)).rejects.toBeInstanceOf(
    BadRequestException,
  );
  expect(
    (
      await prisma.ownerRegistration.findUniqueOrThrow({
        where: { id: owner.registrationId },
      })
    ).completedTenantId,
  ).toBeNull();
});
