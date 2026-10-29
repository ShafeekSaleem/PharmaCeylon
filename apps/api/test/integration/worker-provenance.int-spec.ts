import { randomUUID } from "node:crypto";
import { AuditService } from "../../src/audit/audit.service";
import { CategoryTaxonomyService } from "../../src/catalog/category-taxonomy.service";
import { StockService } from "../../src/inventory/stock/stock.service";
import { NmraImportService } from "../../src/nmra/nmra-import.service";
import type { NmraProductRow } from "../../src/nmra/nmra-normalize";
import { ProductImportService } from "../../src/product-import/product-import.service";
import { createTenantAwarePrismaProxy } from "../../src/prisma/tenant-aware-prisma.proxy";
import { AccessService } from "../../src/security/access.service";
import {
  WorkerAuthority,
  WorkerAuthorityRevokedError,
  workerInitiator,
} from "../../src/security/worker-authority";
import { createPrisma, createTenant, TenantFixture } from "./fixtures";

/** P1 #47: background writers carry and revalidate the authority that started them. */
const prisma = createPrisma();
const proxy = createTenantAwarePrismaProxy(prisma);
const stock = new StockService();
const audit = new AuditService(proxy as never);
const access = new AccessService(proxy as never, {} as never);
const workers = new WorkerAuthority(access);
let fx: TenantFixture;

const mapping = {
  name: "Name",
  qty: "Qty",
  costPrice: "Cost",
  sellingPrice: "Sell",
  batchNo: "Batch",
};
function csv(rows: number, label = randomUUID().slice(0, 8)) {
  const lines = ["Name,Qty,Cost,Sell,Batch"];
  for (let i = 0; i < rows; i += 1) lines.push(`Item ${label} ${i},5,8,12,B-${label}-${i}`);
  return {
    buffer: Buffer.from(`${lines.join("\n")}\n`),
    originalname: "opening.csv",
  } as Express.Multer.File;
}

/** The real service with a runner that hands the job back to the test instead of starting it. */
function importer(authority: WorkerAuthority = workers) {
  let run: (() => Promise<void>) | undefined;
  const runner = {
    start: (_job: string, _tenant: string, id: string, work: (ctx: unknown) => Promise<void>) => {
      run = () => work({ jobId: id, importId: id, progress: () => {} });
    },
  };
  const service = new ProductImportService(
    proxy as never,
    audit,
    new CategoryTaxonomyService(proxy as never),
    runner as never,
    { refresh: async () => {} } as never,
    stock,
    authority,
  );
  return { service, run: () => run!() };
}

async function tokenVersion(userId: string) {
  return (await prisma.appUser.findUniqueOrThrow({ where: { id: userId } })).tokenVersion;
}
const bump = (userId: string) =>
  prisma.appUser.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } });
const importedProducts = (label: string) =>
  prisma.product.count({ where: { tenantId: fx.tenantId, name: { startsWith: `Item ${label}` } } });
const ledgerRows = (importId: string) =>
  prisma.stockLedger.count({ where: { tenantId: fx.tenantId, referenceId: importId } });

beforeAll(async () => {
  fx = await createTenant(prisma, "worker-provenance");
  await prisma.userBranchRole.createMany({
    data: [
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.ownerId, role: "owner" },
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.managerId, role: "manager" },
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.clerkId, role: "inventory_clerk" },
    ],
  });
});
afterAll(() => prisma.$disconnect());
afterEach(() => jest.restoreAllMocks());

describe("product import worker", () => {
  it("persists the starting request's authority and writes with it", async () => {
    const label = randomUUID().slice(0, 8);
    const { service, run } = importer();
    const version = await tokenVersion(fx.managerId);
    const started = await service.startImport(
      fx.tenantId,
      { userId: fx.managerId, tokenVersion: version },
      fx.mainBranchId,
      csv(3, label),
      mapping,
      [],
      {},
      randomUUID(),
    );
    const saved = await prisma.productImport.findUniqueOrThrow({ where: { id: started.importId } });
    expect(saved).toMatchObject({
      createdBy: fx.managerId,
      initiatedVia: "request",
      initiatorTokenVersion: version,
      initiatorBranchId: fx.mainBranchId,
      initiatorPermission: "products.import",
    });
    await run();
    expect(await importedProducts(label)).toBe(3);
    expect(await ledgerRows(started.importId)).toBe(3);
  });

  it("writes nothing when the starter's permission is removed before the worker runs", async () => {
    const label = randomUUID().slice(0, 8);
    const { service, run } = importer();
    const started = await service.startImport(
      fx.tenantId,
      { userId: fx.clerkId, tokenVersion: await tokenVersion(fx.clerkId) },
      fx.mainBranchId,
      csv(2, label),
      mapping,
      [],
      {},
      randomUUID(),
    );
    const role = await prisma.userBranchRole.findFirstOrThrow({
      where: { tenantId: fx.tenantId, userId: fx.clerkId, branchId: fx.mainBranchId },
    });
    await prisma.userBranchRole.delete({ where: { id: role.id } });
    try {
      await expect(run()).rejects.toBeInstanceOf(WorkerAuthorityRevokedError);
    } finally {
      await prisma.userBranchRole.create({
        data: { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.clerkId, role: "inventory_clerk" },
      });
    }
    expect(await importedProducts(label)).toBe(0);
    expect(await ledgerRows(started.importId)).toBe(0);
    const stopped = await prisma.auditEvent.findFirst({
      where: { tenantId: fx.tenantId, entityId: started.importId, eventName: "products.import_stopped" },
    });
    expect(stopped?.actorUserId).toBe(fx.clerkId);
    expect(stopped?.payload).toEqual({ reason: "initiator_authority_revoked" });
  });

  it("stops mid-job when the starter's sign-in changes between write chunks", async () => {
    const label = randomUUID().slice(0, 8);
    // Revoke between the first and second product chunk (100 rows each), on another connection.
    let calls = 0;
    const revoking = new WorkerAuthority(access);
    const real = revoking.assertCurrent.bind(revoking);
    jest.spyOn(revoking, "assertCurrent").mockImplementation(async (tx, initiator) => {
      calls += 1;
      if (calls === 2) await bump(fx.managerId);
      return real(tx, initiator);
    });
    const { service, run } = importer(revoking);
    const started = await service.startImport(
      fx.tenantId,
      { userId: fx.managerId, tokenVersion: await tokenVersion(fx.managerId) },
      fx.mainBranchId,
      csv(150, label),
      mapping,
      [],
      {},
      randomUUID(),
    );
    await expect(run()).rejects.toBeInstanceOf(WorkerAuthorityRevokedError);
    // The first committed chunk is kept; nothing after the revocation was written.
    expect(await importedProducts(label)).toBe(100);
    expect(await ledgerRows(started.importId)).toBe(0);
    const record = await prisma.productImport.findUniqueOrThrow({ where: { id: started.importId } });
    expect(record.status).toBe("running"); // the real runner marks it failed; this stub does not
    expect(record.result).toBeNull();
  });

  it("owner jobs are revalidated the same way", async () => {
    const label = randomUUID().slice(0, 8);
    const { service, run } = importer();
    await service.startImport(
      fx.tenantId,
      { userId: fx.ownerId, tokenVersion: await tokenVersion(fx.ownerId) },
      undefined,
      csv(1, label),
      { name: "Name" },
      [],
      {},
      randomUUID(),
    );
    await bump(fx.ownerId);
    await expect(run()).rejects.toBeInstanceOf(WorkerAuthorityRevokedError);
    expect(await importedProducts(label)).toBe(0);
  });

  it("never writes for a legacy row that has no recorded authority", async () => {
    const legacy = await prisma.productImport.create({
      data: { tenantId: fx.tenantId, createdBy: fx.managerId, filename: "old.csv", status: "running" },
    });
    expect(legacy.initiatedVia).toBe("legacy");
    const { service } = importer();
    const write = jest.fn();
    await expect(
      (service as unknown as {
        inImportTransaction(t: string, i: string, w: () => unknown): Promise<unknown>;
      }).inImportTransaction(fx.tenantId, legacy.id, write),
    ).rejects.toBeInstanceOf(WorkerAuthorityRevokedError);
    expect(write).not.toHaveBeenCalled();
  });

  it("keeps provenance immutable and well-formed in the database", async () => {
    const record = await prisma.productImport.create({
      data: {
        tenantId: fx.tenantId,
        branchId: fx.mainBranchId,
        createdBy: fx.managerId,
        filename: "x.csv",
        initiatedVia: "request",
        initiatorTokenVersion: 0,
        initiatorBranchId: fx.mainBranchId,
        initiatorPermission: "products.import",
      },
    });
    await expect(
      prisma.productImport.update({ where: { id: record.id }, data: { createdBy: fx.ownerId } }),
    ).rejects.toThrow(/immutable/);
    await expect(
      prisma.productImport.update({ where: { id: record.id }, data: { initiatorTokenVersion: 5 } }),
    ).rejects.toThrow(/immutable/);
    // Ordinary progress writes still work.
    await prisma.productImport.update({ where: { id: record.id }, data: { phase: "products" } });
    await expect(
      prisma.productImport.create({
        data: {
          tenantId: fx.tenantId,
          branchId: fx.mainBranchId,
          createdBy: fx.managerId,
          filename: "bad.csv",
          initiatedVia: "request",
          initiatorTokenVersion: 0,
          initiatorBranchId: fx.otherBranchId,
          initiatorPermission: "products.import",
        },
      }),
    ).rejects.toThrow(/product_import_initiator_shape/);
  });
});

describe("NMRA register import job", () => {
  const nmra = () =>
    new NmraImportService(proxy as never, audit, new CategoryTaxonomyService(proxy as never), workers);
  const row = (reg: string): NmraProductRow => ({
    id: reg,
    sku: `NMRA-${reg}`,
    name: `REGISTER ${reg}`,
    brandName: null,
    genericName: "PARACETAMOL",
    manufacturer: null,
    dosageForm: "Tablet",
    dosageFormGroup: "Tablet",
    strength: "500mg",
    unit: null,
    packSize: null,
    packType: null,
    barcode: null,
    registrationNo: reg,
    registrationDate: null,
    schedule: null,
    scheduleGroup: null,
    regType: null,
    dossierNo: null,
    countryOfOrigin: null,
    localAgent: null,
    isControlled: false,
    requiresPrescription: false,
    isUnbranded: false,
    isActive: true,
    reorderLevel: 0,
  });
  const upsertRows = (service: NmraImportService, initiator: unknown, rows: NmraProductRow[]) =>
    (service as unknown as {
      upsertRows(i: unknown, r: NmraProductRow[]): Promise<{ created: number }>;
    }).upsertRows(initiator, rows);

  it("writes register rows while the starter still holds nmra.import", async () => {
    const reg = `REG-${randomUUID().slice(0, 8)}`;
    const initiator = workerInitiator(
      { tenantId: fx.tenantId, userId: fx.managerId, tokenVersion: await tokenVersion(fx.managerId) },
      null,
      "nmra.import",
    );
    await expect(upsertRows(nmra(), initiator, [row(reg)])).resolves.toMatchObject({ created: 1 });
    expect(await prisma.product.count({ where: { tenantId: fx.tenantId, registrationNo: reg } })).toBe(1);
  });

  it("writes nothing for a starter whose sign-in changed", async () => {
    const reg = `REG-${randomUUID().slice(0, 8)}`;
    const initiator = workerInitiator(
      { tenantId: fx.tenantId, userId: fx.managerId, tokenVersion: await tokenVersion(fx.managerId) },
      null,
      "nmra.import",
    );
    await bump(fx.managerId);
    await expect(upsertRows(nmra(), initiator, [row(reg)])).rejects.toBeInstanceOf(
      WorkerAuthorityRevokedError,
    );
    expect(await prisma.product.count({ where: { tenantId: fx.tenantId, registrationNo: reg } })).toBe(0);
  });

  it("stops a relation phase at its next write batch when the permission is removed mid-phase", async () => {
    const label = `MID-${randomUUID().slice(0, 8)}`;
    // Two aliases per row (registration + dossier number): 500 aliases = batches of 400 and 100.
    const rows = Array.from({ length: 250 }, (_, i) => ({ ...row(`${label}-${i}`), dossierNo: `D-${label}-${i}` }));
    const initiator = workerInitiator(
      { tenantId: fx.tenantId, userId: fx.managerId, tokenVersion: await tokenVersion(fx.managerId) },
      null,
      "nmra.import",
    );
    const service = nmra();
    let phase = "";
    let aliasChecks = 0;
    const role = await prisma.userBranchRole.findFirstOrThrow({
      where: { tenantId: fx.tenantId, userId: fx.managerId, branchId: fx.mainBranchId },
    });
    const real = workers.assertCurrent.bind(workers);
    jest.spyOn(workers, "assertCurrent").mockImplementation(async (tx, who) => {
      // Between the first and second alias batch, on another connection.
      if (phase === "aliases" && ++aliasChecks === 2)
        await prisma.userBranchRole.delete({ where: { id: role.id } });
      return real(tx, who);
    });
    try {
      await expect(
        (service as unknown as {
          upsertRows(i: unknown, r: NmraProductRow[], p: (x: { phase: string }) => void): Promise<unknown>;
        }).upsertRows(initiator, rows, (p) => {
          phase = p.phase;
        }),
      ).rejects.toBeInstanceOf(WorkerAuthorityRevokedError);
    } finally {
      await prisma.userBranchRole.create({
        data: { id: role.id, tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.managerId, role: "manager" },
      });
    }
    const products = await prisma.product.findMany({
      where: { tenantId: fx.tenantId, registrationNo: { startsWith: label } },
      select: { id: true },
    });
    expect(products).toHaveLength(250);
    // The first alias batch committed; nothing after the revocation did.
    expect(
      await prisma.productAlias.count({ where: { tenantId: fx.tenantId, productId: { in: products.map((p) => p.id) } } }),
    ).toBe(400);
  });

  it("records who started the job and stops it on revocation", async () => {
    const service = nmra();
    const version = await tokenVersion(fx.ownerId);
    const parse = jest
      .spyOn(service as unknown as { parseFile(): NmraProductRow[] }, "parseFile")
      .mockReturnValue([row(`REG-${randomUUID().slice(0, 8)}`)]);
    const gate = jest
      .spyOn(workers, "assertCurrent")
      .mockImplementationOnce(async () => {
        await bump(fx.ownerId);
        throw new WorkerAuthorityRevokedError();
      });
    const { jobId } = await service.startUpsertJob(
      fx.tenantId,
      { userId: fx.ownerId, tokenVersion: version },
      {} as Express.Multer.File,
    );
    for (let i = 0; i < 100 && service.getJobProgress(fx.tenantId, jobId).status !== "failed"; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(parse).toHaveBeenCalled();
    expect(gate).toHaveBeenCalled();
    expect(service.getJobProgress(fx.tenantId, jobId)).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/no longer has NMRA import permission/),
    });
    const events = await prisma.auditEvent.findMany({
      where: { tenantId: fx.tenantId, entityId: jobId },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((e) => e.eventName)).toEqual([
      "products.nmra_import_started",
      "products.nmra_import_stopped",
    ]);
    expect(events[0]!.payload).toMatchObject({ tokenVersion: version, permission: "nmra.import" });
  });
});
