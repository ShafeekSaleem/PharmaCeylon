import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConflictException } from "@nestjs/common";
import { Prisma, RoleName } from "@prisma/client";
import { validateBranchHours } from "@pharmaceylon/shared";
import { AuditService } from "../../src/audit/audit.service";
import { BranchHoursService } from "../../src/tenant/branch-hours.service";
import { HolidaySuggestionsSource } from "../../src/tenant/holiday-suggestions";
import { createPrisma, createTenant, type TenantFixture } from "./fixtures";

const prisma = createPrisma();
const service = new BranchHoursService(
  prisma as never,
  new AuditService(prisma as never),
  { notifyByPermission: async () => 0 } as never,
  new HolidaySuggestionsSource(),
);
let fx: TenantFixture;

const read = async (text: string | null) =>
  (await prisma.$queryRaw<Array<{ hours: unknown }>>`SELECT pc_parse_legacy_opening_hours(${text}) AS hours`)[0]
    .hours as { weekly: Record<string, unknown>; mandatory: unknown } | null;
const hours = (opens: string, closes: string) => ({ mode: "hours", ranges: [{ opens, closes }] });
const closed = { mode: "closed" };
const week = (days: Record<string, unknown>, fallback: unknown = closed) =>
  Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, days[d] ?? fallback]));

beforeAll(async () => {
  fx = await createTenant(prisma, "hours");
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe("migration: reading the old free-text opening hours", () => {
  const weekday = hours("08:00", "20:00");
  const cases: Array<[string, Record<string, unknown>]> = [
    ["Mon–Fri 08:00–20:00; Sat 08:00–18:00", week({ mon: weekday, tue: weekday, wed: weekday, thu: weekday, fri: weekday, sat: hours("08:00", "18:00") })],
    // Sunday isn't mentioned, so it's closed.
    ["Mon-Sat 8am-9pm", week({ sun: closed }, hours("08:00", "21:00"))],
    ["Daily 8.00 a.m. to 10.00 p.m.", week({}, hours("08:00", "22:00"))],
    ["Open 24/7", week({}, { mode: "open_24h" })],
    ["24 hours", week({}, { mode: "open_24h" })],
    ["08:00-20:00", week({}, weekday)],
    ["Fri 18:00 - 02:00", week({ fri: hours("18:00", "02:00") })],
    ["Daily 8am-10pm; Sunday 9am-1pm", week({ sun: hours("09:00", "13:00") }, hours("08:00", "22:00"))],
    ["Mon, Wed, Fri 9am-5pm", week({ mon: hours("09:00", "17:00"), wed: hours("09:00", "17:00"), fri: hours("09:00", "17:00") })],
    ["Weekdays 0800-2000hrs, Weekends 0900-1300hrs", week({ sat: hours("09:00", "13:00"), sun: hours("09:00", "13:00") }, weekday)],
    ["Mon - Fri 8am - 12 midnight", week({ mon: hours("08:00", "24:00"), tue: hours("08:00", "24:00"), wed: hours("08:00", "24:00"), thu: hours("08:00", "24:00"), fri: hours("08:00", "24:00") })],
  ];
  it.each(cases)("reads %j", async (text, weekly) => {
    const parsed = await read(text);
    expect(parsed?.weekly).toEqual(weekly);
    expect(parsed?.mandatory).toBeNull();
    // What the migration writes is a document the API accepts as it stands.
    expect(validateBranchHours(parsed).ok).toBe(true);
  });

  it("splits a day into several ranges", async () => {
    const parsed = await read("Mon - Fri 8am - 1pm, 2pm - 6pm, Sat 9am - 1pm, Sun closed");
    expect(parsed?.weekly.mon).toEqual({
      mode: "hours",
      ranges: [{ opens: "08:00", closes: "13:00" }, { opens: "14:00", closes: "18:00" }],
    });
    expect(parsed?.weekly.sun).toEqual(closed);
  });

  it.each([
    "8 - 5", // morning or evening?
    "8-10pm", // 8am or 8pm?
    "Mon-Fri 10:00-06:00", // past midnight from a morning opening
    "Mon-Sat 8am-9pm, Sunday & Poya closed", // poya days have no fixed weekday
    "Open on weekdays",
    "Mon-Fri 9am-1pm, 12pm-5pm", // overlapping ranges
    "",
  ])("leaves %j for a person instead of guessing", async (text) => {
    expect(await read(text)).toBeNull();
  });

  it("backfills readable text, keeps the text, and leaves the rest unset", async () => {
    const backfill = readFileSync(
      join(__dirname, "../../prisma/migrations/20261027000000_structured_branch_hours/migration.sql"),
      "utf8",
    ).match(/^UPDATE branch[\s\S]*?;$/m)?.[0];
    expect(backfill).toBeDefined();
    const tenant = await createTenant(prisma, "hours-backfill");
    const set = (id: string, text: string) =>
      prisma.branch.updateMany({ where: { tenantId: tenant.tenantId, id }, data: { legacyOpeningHours: text } });
    await set(tenant.mainBranchId, "Mon-Fri 8am-8pm; Sat 9am-1pm");
    await set(tenant.otherBranchId, "8 - 5, poya days closed");

    await prisma.$executeRawUnsafe(backfill!);

    const rows = await prisma.branch.findMany({
      where: { tenantId: tenant.tenantId },
      select: { id: true, legacyOpeningHours: true, operatingHours: true, operatingHoursOrigin: true, operatingHoursVersion: true },
    });
    const main = rows.find((r) => r.id === tenant.mainBranchId)!;
    const other = rows.find((r) => r.id === tenant.otherBranchId)!;
    expect(main).toMatchObject({ legacyOpeningHours: "Mon-Fri 8am-8pm; Sat 9am-1pm", operatingHoursOrigin: "legacy_text", operatingHoursVersion: 1 });
    expect((main.operatingHours as { weekly: Record<string, unknown> }).weekly.sat).toEqual(hours("09:00", "13:00"));
    expect((main.operatingHours as { mandatory: unknown }).mandatory).toBeNull();
    expect(other).toMatchObject({ legacyOpeningHours: "8 - 5, poya days closed", operatingHours: null, operatingHoursOrigin: null });
  });

  it("never turns old text into a mandatory restriction", async () => {
    const parsedTexts = await Promise.all(cases.map(([text]) => read(text)));
    expect(parsedTexts.every((parsed) => parsed?.mandatory === null)).toBe(true);

    const legacyWithMandatory = prisma.$executeRaw`
      UPDATE branch SET operating_hours = ${JSON.stringify({ schemaVersion: 1, weekly: {}, exceptions: [], mandatory: [] })}::jsonb,
             operating_hours_origin = 'legacy_text'
       WHERE tenant_id = ${fx.tenantId}::uuid AND id = ${fx.otherBranchId}::uuid`;
    await expect(legacyWithMandatory).rejects.toThrow(/branch_operating_hours_shape/);
  });

  it("refuses a stored document without D8's mandatory value", async () => {
    const noMandatory = prisma.$executeRaw`
      UPDATE branch SET operating_hours = ${JSON.stringify({ schemaVersion: 1, weekly: {}, exceptions: [] })}::jsonb,
             operating_hours_origin = 'editor'
       WHERE tenant_id = ${fx.tenantId}::uuid AND id = ${fx.otherBranchId}::uuid`;
    await expect(noMandatory).rejects.toThrow(/branch_operating_hours_shape/);
  });
});

describe("hours and business extensions against the database", () => {
  const ownerActor = () => ({ userId: fx.ownerId, branchRoles: [{ branchId: fx.mainBranchId, role: RoleName.owner }] });
  const doc = { schemaVersion: 1, weekly: week({}, hours("08:00", "20:00")), exceptions: [], mandatory: null };

  it("saves against the loaded version and refuses the second of two concurrent saves", async () => {
    const before = await service.getHours(fx.tenantId, fx.mainBranchId);
    expect(before).toMatchObject({ hours: null, origin: null, version: 1 });

    const saved = await service.updateHours(fx.tenantId, ownerActor(), fx.mainBranchId, {
      expectedVersion: before.version,
      hours: doc,
    });
    expect(saved).toMatchObject({ origin: "editor", version: 2 });
    expect(saved.updatedBy?.id).toBe(fx.ownerId);

    const stale = service.updateHours(fx.tenantId, ownerActor(), fx.mainBranchId, {
      expectedVersion: before.version,
      hours: { ...doc, mandatory: [{ day: "mon", opens: "06:00", closes: "22:00" }] },
    });
    await expect(stale).rejects.toBeInstanceOf(ConflictException);

    const events = await prisma.auditEvent.count({
      where: { tenantId: fx.tenantId, entityId: fx.mainBranchId, eventName: "branch.hours_updated" },
    });
    expect(events).toBe(1);
  });

  it("keeps extensions as evidence: no overlap, no edits, no deletes, one revocation", async () => {
    const now = new Date();
    const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();
    const view = await service.createExtension(fx.tenantId, ownerActor(), fx.mainBranchId, {
      startsAt: at(60),
      endsAt: at(180),
      reason: "Late opening for a festival",
    });
    expect(view.extensions).toHaveLength(1);
    const [extension] = view.extensions;

    await expect(
      service.createExtension(fx.tenantId, ownerActor(), fx.mainBranchId, {
        startsAt: at(120),
        endsAt: at(240),
        reason: "Overlapping",
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    await expect(
      prisma.branchHoursExtension.updateMany({
        where: { tenantId: fx.tenantId, id: extension.id },
        data: { reason: "Rewritten" },
      }),
    ).rejects.toThrow(/immutable/);
    await expect(
      prisma.branchHoursExtension.deleteMany({ where: { tenantId: fx.tenantId, id: extension.id } }),
    ).rejects.toThrow(/retained/);

    const revoked = await service.revokeExtension(fx.tenantId, ownerActor(), fx.mainBranchId, extension.id, {
      reason: "Festival cancelled",
    });
    expect(revoked.extensions).toHaveLength(0);
    await expect(
      prisma.branchHoursExtension.updateMany({
        where: { tenantId: fx.tenantId, id: extension.id },
        data: { revocationReason: "Changed my mind" },
      }),
    ).rejects.toThrow(/immutable/);

    const row = await prisma.branchHoursExtension.findFirstOrThrow({
      where: { tenantId: fx.tenantId, id: extension.id },
    });
    expect(row).toMatchObject({ revokedByUserId: fx.ownerId, revocationReason: "Festival cancelled" });
  });

  it("refuses an extension longer than a day at the database too", async () => {
    const insert = prisma.$executeRaw(Prisma.sql`
      INSERT INTO branch_hours_extension (id, tenant_id, branch_id, starts_at, ends_at, reason, approved_by_user_id)
      VALUES (gen_random_uuid(), ${fx.tenantId}::uuid, ${fx.mainBranchId}::uuid, now(), now() + interval '25 hours',
              'Too long', ${fx.ownerId}::uuid)`);
    await expect(insert).rejects.toThrow(/branch_hours_extension_shape/);
  });
});
