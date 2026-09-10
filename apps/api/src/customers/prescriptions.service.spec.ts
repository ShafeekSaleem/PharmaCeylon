import { PrescriptionsService } from "./prescriptions.service";

describe("PrescriptionsService.list", () => {
  let prisma: any;
  let service: PrescriptionsService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = {
      prescription: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    service = new PrescriptionsService(prisma as never);
  });

  const whereOf = () => prisma.prescription.findMany.mock.calls[0][0].where;

  it("scopes to the tenant and the active branch", async () => {
    await service.list("t1", "b1", {});

    expect(whereOf()).toMatchObject({ tenantId: "t1", branchId: "b1" });
  });

  it("pages from 1 and caps the page size", async () => {
    await service.list("t1", "b1", { page: 4, pageSize: 999 });

    const args = prisma.prescription.findMany.mock.calls[0][0];
    expect(args.take).toBe(100);
    expect(args.skip).toBe(300);
  });

  it("treats a prescription with no expiry as still valid", async () => {
    // The subtle case: `validUntil: null` means "never lapses", so filtering to
    // valid must include it rather than silently dropping it.
    await service.list("t1", "b1", { validity: "valid" });

    const or = whereOf().OR;
    expect(or).toContainEqual({ validUntil: null });
    expect(or).toHaveLength(2);
  });

  it("excludes never-expiring prescriptions from the expired list", async () => {
    await service.list("t1", "b1", { validity: "expired" });

    const where = whereOf();
    expect(where.validUntil).toHaveProperty("lt");
    expect(where.OR).toBeUndefined();
  });

  it("compares validity against midnight UTC, so today is not yet expired", async () => {
    await service.list("t1", "b1", { validity: "expired" });

    const cutoff: Date = whereOf().validUntil.lt;
    expect(cutoff.getUTCHours()).toBe(0);
    expect(cutoff.getUTCMinutes()).toBe(0);
    expect(cutoff.getUTCSeconds()).toBe(0);
  });

  it("applies no validity clause when unfiltered", async () => {
    await service.list("t1", "b1", {});

    const where = whereOf();
    expect(where.OR).toBeUndefined();
    expect(where.validUntil).toBeUndefined();
  });

  it("keeps the search terms out of the validity clause", async () => {
    // Search is nested under AND so it cannot collide with the validity OR —
    // a flat OR would widen "valid" back out to everything matching the term.
    await service.list("t1", "b1", { q: "amoxi", validity: "valid" });

    const where = whereOf();
    expect(where.OR).toHaveLength(2);
    expect(where.AND[0].OR).toHaveLength(3);
  });

  it("orders by issue date, newest first", async () => {
    await service.list("t1", "b1", {});

    expect(prisma.prescription.findMany.mock.calls[0][0].orderBy).toEqual({
      issuedOn: "desc",
    });
  });
});
