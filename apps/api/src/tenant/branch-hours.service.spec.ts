import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ValidationPipe,
} from "@nestjs/common";
import { RoleName } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { NotificationsService } from "../notifications/notifications.service";
import { BranchRole } from "../security/interfaces/authenticated-request.interface";
import { BranchHoursService } from "./branch-hours.service";
import { CreateBranchHoursExtensionDto, UpdateBranchHoursDto } from "./dto/branch-hours.dto";
import { UpdateBranchDto } from "./dto/update-branch.dto";
import { CreateBranchDto } from "./dto/create-branch.dto";
import { HolidaySuggestionsSource } from "./holiday-suggestions";

const tenantId = "tenant-1";
const branchId = "11111111-1111-4111-8111-111111111111";
const otherBranchId = "22222222-2222-4222-8222-222222222222";
type Actor = { userId: string; branchRoles: BranchRole[] };
const owner: Actor = { userId: "owner-1", branchRoles: [{ branchId: otherBranchId, role: RoleName.owner }] };
const manager: Actor = { userId: "manager-1", branchRoles: [{ branchId, role: RoleName.manager }] };
const elsewhereManager: Actor = {
  userId: "manager-2",
  branchRoles: [{ branchId: otherBranchId, role: RoleName.manager }],
};
const now = new Date("2026-10-27T04:30:00.000Z"); // 10:00 in Colombo

const open = { mode: "hours", ranges: [{ opens: "08:00", closes: "20:00" }] };
function hoursDoc(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    weekly: { mon: open, tue: open, wed: open, thu: open, fri: open, sat: open, sun: { mode: "closed" } },
    exceptions: [],
    mandatory: null,
    ...overrides,
  };
}

function branchRow(overrides: Record<string, unknown> = {}) {
  return {
    id: branchId,
    name: "Colombo 03",
    timezone: "Asia/Colombo",
    legacyOpeningHours: "Mon-Sat 8am-8pm",
    operatingHours: hoursDoc(),
    operatingHoursOrigin: "legacy_text",
    operatingHoursVersion: 3,
    operatingHoursUpdatedAt: new Date("2026-10-27T00:00:00.000Z"),
    operatingHoursUpdatedBy: null,
    ...overrides,
  };
}

describe("BranchHoursService", () => {
  let prisma: {
    branch: { findFirst: jest.Mock; updateMany: jest.Mock };
    branchHoursExtension: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      updateMany: jest.Mock;
    };
    appUser: { findMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let audit: { log: jest.Mock };
  let notifications: { notifyByPermission: jest.Mock };
  let holidays: { forYear: jest.Mock };
  let service: BranchHoursService;

  beforeEach(() => {
    prisma = {
      branch: { findFirst: jest.fn().mockResolvedValue(branchRow()), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      branchHoursExtension: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: "ext-1" }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      appUser: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));
    audit = { log: jest.fn() };
    notifications = { notifyByPermission: jest.fn().mockResolvedValue(0) };
    holidays = { forYear: jest.fn().mockReturnValue(null) };
    service = new BranchHoursService(
      prisma as never,
      audit as unknown as AuditService,
      notifications as unknown as NotificationsService,
      holidays as unknown as HolidaySuggestionsSource,
    );
  });

  const update = (actor: Actor, dto: Partial<UpdateBranchHoursDto>) =>
    service.updateHours(tenantId, actor, branchId, { expectedVersion: 3, hours: hoursDoc(), ...dto } as UpdateBranchHoursDto, now);

  describe("getHours", () => {
    it("returns the structured hours beside the old text, with approver names", async () => {
      prisma.branch.findFirst.mockResolvedValue(branchRow({ operatingHoursUpdatedBy: "owner-1" }));
      prisma.branchHoursExtension.findMany.mockResolvedValue([
        {
          id: "ext-1",
          startsAt: new Date("2026-10-31T14:30:00.000Z"),
          endsAt: new Date("2026-10-31T17:30:00.000Z"),
          reason: "Festival night",
          approvedByUserId: "manager-1",
          approvedAt: now,
        },
      ]);
      prisma.appUser.findMany.mockResolvedValue([
        { id: "owner-1", fullName: "Owner One" },
        { id: "manager-1", fullName: "Manager One" },
      ]);

      const view = await service.getHours(tenantId, branchId);

      expect(prisma.branch.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: branchId, tenantId } }),
      );
      expect(prisma.branchHoursExtension.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ tenantId, branchId, revokedAt: null }) }),
      );
      expect(view).toMatchObject({
        version: 3,
        origin: "legacy_text",
        legacyText: "Mon-Sat 8am-8pm",
        updatedBy: { id: "owner-1", name: "Owner One" },
        extensions: [{ id: "ext-1", reason: "Festival night", approvedBy: { name: "Manager One" } }],
      });
      expect(view.hours?.mandatory).toBeNull();
    });

    it("reports no hours (not an invented schedule) for a branch whose text couldn't be read", async () => {
      prisma.branch.findFirst.mockResolvedValue(
        branchRow({ operatingHours: null, operatingHoursOrigin: null, legacyOpeningHours: "8 - 5" }),
      );
      const view = await service.getHours(tenantId, branchId);
      expect(view).toMatchObject({ hours: null, origin: null, legacyText: "8 - 5" });
    });

    it("does not reach another tenant's branch", async () => {
      prisma.branch.findFirst.mockResolvedValue(null);
      await expect(service.getHours(tenantId, branchId)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("updateHours", () => {
    it("saves a normalized document against the version the editor loaded, with an audit", async () => {
      const weekly = { ...hoursDoc().weekly, fri: { mode: "open_24h" }, sun: { mode: "hours", ranges: [{ opens: "09:00", closes: "00:00" }] } };
      await update(owner, { hours: hoursDoc({ weekly }) });

      expect(prisma.branch.updateMany).toHaveBeenCalledWith({
        where: { id: branchId, tenantId, operatingHoursVersion: 3 },
        data: expect.objectContaining({
          operatingHoursOrigin: "editor",
          operatingHoursVersion: { increment: 1 },
          operatingHoursUpdatedBy: "owner-1",
          operatingHours: expect.objectContaining({
            weekly: expect.objectContaining({
              fri: { mode: "open_24h" },
              sun: { mode: "hours", ranges: [{ opens: "09:00", closes: "24:00" }] },
            }),
            mandatory: null,
          }),
        }),
      });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: "branch.hours_updated",
          branchId,
          payload: expect.objectContaining({ fromVersion: 3, toVersion: 4, changed: ["weekly"], noSelling: false }),
        }),
        prisma,
      );
    });

    it("refuses a stale version instead of overwriting someone else's change", async () => {
      prisma.branch.updateMany.mockResolvedValue({ count: 0 });
      const error = await update(owner, { expectedVersion: 2, hours: hoursDoc({ exceptions: [] , weekly: { ...hoursDoc().weekly, sun: open } }) }).catch((e) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse()).toMatchObject({ code: "HOURS_VERSION_CONFLICT" });
    });

    it("refuses an invalid document with every reason, including unknown fields", async () => {
      const error = await update(owner, {
        hours: { ...hoursDoc({ weekly: { ...hoursDoc().weekly, mon: { mode: "hours", ranges: [{ opens: "9", closes: "17:00" }] } } }), source: "x" },
      }).catch((e) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.getResponse()).toMatchObject({ code: "INVALID_BRANCH_HOURS" });
      expect(prisma.branch.updateMany).not.toHaveBeenCalled();
    });

    it("lets the branch's manager change routine hours and exceptions", async () => {
      await update(manager, {
        hours: hoursDoc({
          exceptions: [{ date: "2026-11-05", label: "Stocktake", hours: { mode: "closed" }, source: "owner", holidayKey: null }],
        }),
      });
      expect(prisma.branch.updateMany).toHaveBeenCalled();
    });

    it("keeps mandatory limits owner-only", async () => {
      const error = await update(manager, {
        hours: hoursDoc({ mandatory: [{ day: "mon", opens: "06:00", closes: "22:00" }] }),
      }).catch((e) => e);
      expect(error).toBeInstanceOf(ForbiddenException);
      expect(error.getResponse()).toMatchObject({ code: "MANDATORY_HOURS_OWNER_ONLY" });

      prisma.branch.findFirst.mockResolvedValue(
        branchRow({ operatingHours: hoursDoc({ mandatory: [{ day: "mon", opens: "06:00", closes: "22:00" }] }) }),
      );
      const removing = await update(manager, { hours: hoursDoc({ mandatory: null }) }).catch((e) => e);
      expect(removing).toBeInstanceOf(ForbiddenException);
      expect(prisma.branch.updateMany).not.toHaveBeenCalled();
    });

    it("refuses a manager of a different branch", async () => {
      await expect(update(elsewhereManager, {})).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("needs a second confirmation before saving no selling", async () => {
      const error = await update(owner, { hours: hoursDoc({ mandatory: [] }) }).catch((e) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.getResponse()).toMatchObject({ code: "NO_SELLING_CONFIRMATION_REQUIRED" });
      expect(prisma.branch.updateMany).not.toHaveBeenCalled();

      await update(owner, { hours: hoursDoc({ mandatory: [] }), confirmNoSelling: true });
      expect(prisma.branch.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ operatingHours: expect.objectContaining({ mandatory: [] }) }) }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ noSelling: true, mandatoryBefore: null, mandatoryAfter: [] }),
        }),
        prisma,
      );
      expect(notifications.notifyByPermission).toHaveBeenCalledWith(
        tenantId,
        "tenant.management",
        expect.anything(),
        expect.objectContaining({ severity: "warning", title: 'All selling is stopped at "Colombo 03"' }),
        "owner-1",
      );
    });

    it("doesn't ask again when the branch was already set to no selling", async () => {
      prisma.branch.findFirst.mockResolvedValue(
        branchRow({ operatingHours: hoursDoc({ mandatory: [] }), operatingHoursOrigin: "editor" }),
      );
      await update(owner, { hours: hoursDoc({ mandatory: [], weekly: { ...hoursDoc().weekly, sun: open } }) });
      expect(prisma.branch.updateMany).toHaveBeenCalled();
    });

    it("writes nothing when an edited document comes back unchanged", async () => {
      prisma.branch.findFirst.mockResolvedValue(branchRow({ operatingHoursOrigin: "editor" }));
      await update(owner, {});
      expect(prisma.branch.updateMany).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it("records a person's review of hours read from the old text, even with no edits", async () => {
      await update(manager, {});
      expect(prisma.branch.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ operatingHoursOrigin: "editor" }) }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ payload: expect.objectContaining({ previousOrigin: "legacy_text", changed: [] }) }),
        prisma,
      );
    });
  });

  describe("business extensions", () => {
    const extension = (patch: Partial<CreateBranchHoursExtensionDto> = {}) =>
      service.createExtension(
        tenantId,
        manager,
        branchId,
        { startsAt: "2026-10-27T14:30:00.000Z", endsAt: "2026-10-27T17:30:00.000Z", reason: " Festival night ", ...patch },
        now,
      );

    it("records the approver, bumps the hours version and audits in one transaction", async () => {
      await extension();
      expect(prisma.branch.updateMany).toHaveBeenCalledWith({
        where: { id: branchId, tenantId },
        data: { operatingHoursVersion: { increment: 1 } },
      });
      expect(prisma.branchHoursExtension.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ tenantId, branchId, reason: "Festival night", approvedByUserId: "manager-1" }),
        }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ eventName: "branch.hours_extension_approved", entityId: "ext-1" }),
        prisma,
      );
    });

    it("refuses extensions that are backwards, longer than a day or in the past", async () => {
      await expect(extension({ endsAt: "2026-10-27T14:00:00.000Z" })).rejects.toThrow("end after it starts");
      await expect(extension({ endsAt: "2026-10-28T15:30:00.000Z" })).rejects.toThrow("at most 24 hours");
      await expect(extension({ startsAt: "2026-10-27T03:00:00.000Z" })).rejects.toThrow("in the past");
      expect(prisma.branchHoursExtension.create).not.toHaveBeenCalled();
    });

    it("refuses an overlap with an extension already approved", async () => {
      prisma.branchHoursExtension.findFirst.mockResolvedValue({
        startsAt: new Date("2026-10-27T16:00:00.000Z"),
        endsAt: new Date("2026-10-27T18:00:00.000Z"),
      });
      await expect(extension()).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.branchHoursExtension.create).not.toHaveBeenCalled();
    });

    it("refuses a manager of a different branch", async () => {
      await expect(
        service.createExtension(tenantId, elsewhereManager, branchId, {
          startsAt: "2026-10-27T14:30:00.000Z", endsAt: "2026-10-27T17:30:00.000Z", reason: "x",
        }, now),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("revokes once, keeping the row, and only while it can still matter", async () => {
      prisma.branchHoursExtension.findFirst.mockResolvedValue({
        id: "ext-1", endsAt: new Date("2026-10-27T17:30:00.000Z"), revokedAt: null,
      });
      await service.revokeExtension(tenantId, owner, branchId, "ext-1", { reason: "Cancelled" }, now);
      expect(prisma.branchHoursExtension.updateMany).toHaveBeenCalledWith({
        where: { id: "ext-1", tenantId, branchId, revokedAt: null },
        data: { revokedAt: now, revokedByUserId: "owner-1", revocationReason: "Cancelled" },
      });

      prisma.branchHoursExtension.findFirst.mockResolvedValue({ id: "ext-1", endsAt: new Date("2026-10-27T17:30:00.000Z"), revokedAt: now });
      await expect(
        service.revokeExtension(tenantId, owner, branchId, "ext-1", { reason: "Again" }, now),
      ).rejects.toBeInstanceOf(ConflictException);

      prisma.branchHoursExtension.findFirst.mockResolvedValue({ id: "ext-1", endsAt: new Date("2026-10-27T01:00:00.000Z"), revokedAt: null });
      await expect(
        service.revokeExtension(tenantId, owner, branchId, "ext-1", { reason: "Late" }, now),
      ).rejects.toThrow("already ended");
    });
  });

  describe("holidaySuggestions", () => {
    // Test fixture, not real holiday dates.
    const source = { name: "Test gazette", reference: null, checkedOn: "2026-01-02" };
    const list2026 = {
      year: 2026,
      source,
      holidays: [
        { key: "lk:2026-10-26", date: "2026-10-26", name: "Yesterday", kinds: ["poya"] },
        { key: "lk:2026-10-27", date: "2026-10-27", name: "Today", kinds: ["poya"] },
        { key: "lk:2026-12-25", date: "2026-12-25", name: "Later", kinds: ["public"] },
      ],
    };

    it("offers the rest of this year from the branch's today, and applies none", async () => {
      holidays.forYear.mockImplementation((year: number) => (year === 2026 ? list2026 : null));
      const result = await service.holidaySuggestions(tenantId, branchId, now);
      expect(holidays.forYear).toHaveBeenCalledWith(2026);
      expect(holidays.forYear).toHaveBeenCalledWith(2027);
      expect(result.holidays.map((h) => h.key)).toEqual(["lk:2026-10-27", "lk:2026-12-25"]);
      expect(prisma.branch.updateMany).not.toHaveBeenCalled();
    });

    it("says which years have no list instead of guessing their dates", async () => {
      holidays.forYear.mockImplementation((year: number) => (year === 2026 ? list2026 : null));
      const result = await service.holidaySuggestions(tenantId, branchId, now);
      expect(result.years).toEqual([
        { year: 2026, source },
        { year: 2027, source: null },
      ]);
    });

    it("uses the branch's calendar for the year: 1 January in Colombo is still 31 December in UTC", async () => {
      await service.holidaySuggestions(tenantId, branchId, new Date("2026-12-31T19:00:00.000Z"));
      expect(holidays.forYear).toHaveBeenCalledWith(2027);
      expect(holidays.forYear).toHaveBeenCalledWith(2028);
    });

    it("ships the gazetted years only, and nothing for a year without a gazette file", () => {
      const source = new HolidaySuggestionsSource();
      expect(source.forYear(2026)?.year).toBe(2026);
      expect(source.forYear(2027)?.year).toBe(2027);
      expect(source.forYear(2028)).toBeNull();
    });
  });
});

describe("hours request validation", () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const body = (metatype: new () => object, value: unknown) =>
    pipe.transform(value, { type: "body", metatype });

  it("no longer accepts free-text opening hours on branch create or edit", async () => {
    await expect(body(UpdateBranchDto, { openingHours: "Mon-Fri 9-5" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(body(CreateBranchDto, { code: "B2", name: "Kandy", openingHours: "9-5" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("needs the version the editor loaded and an hours object", async () => {
    await expect(body(UpdateBranchHoursDto, { hours: hoursDoc() })).rejects.toBeInstanceOf(BadRequestException);
    await expect(body(UpdateBranchHoursDto, { expectedVersion: 1, hours: "Mon-Fri" })).rejects.toBeInstanceOf(BadRequestException);
    const ok = (await body(UpdateBranchHoursDto, { expectedVersion: 1, hours: hoursDoc() })) as UpdateBranchHoursDto;
    expect(ok.hours).toMatchObject({ schemaVersion: 1, mandatory: null });
  });
});
