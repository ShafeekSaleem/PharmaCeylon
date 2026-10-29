import { randomUUID } from "node:crypto";
import { StockMovementType } from "@prisma/client";
import { AuditService } from "../../src/audit/audit.service";
import { CategoryTaxonomyService } from "../../src/catalog/category-taxonomy.service";
import { StockService } from "../../src/inventory/stock/stock.service";
import {
  ImportStockService,
  StagedStockRow,
} from "../../src/product-import/import-stock.service";
import { ProductImportService } from "../../src/product-import/product-import.service";
import { createTenantAwarePrismaProxy } from "../../src/prisma/tenant-aware-prisma.proxy";
import { AccessService } from "../../src/security/access.service";
import { WorkerAuthority } from "../../src/security/worker-authority";
import { RequestUser } from "../../src/security/interfaces/authenticated-request.interface";
import { createPrisma, createTenant, TenantFixture } from "./fixtures";

const prisma = createPrisma();
const proxy = createTenantAwarePrismaProxy(prisma);
const stock = new StockService();
const audit = new AuditService(proxy as never);
const access = new AccessService(proxy as never, {} as never);
const drafts = new ImportStockService(proxy as never, stock, audit, access);
const workers = new WorkerAuthority(access);
let fx: TenantFixture;
const user = (userId = fx.ownerId): RequestUser => ({
  tenantId: fx.tenantId,
  userId,
  tokenVersion: 0,
  branchRoles: [],
  email: "import@it.test",
  fullName: "Import staff",
  authMethod: "bearer",
});
const row = (overrides: Partial<StagedStockRow> = {}): StagedStockRow => ({
  rowNumber: 2,
  productId: fx.productId,
  name: "Opening product",
  categoryName: "Medicines",
  qty: 12,
  costPrice: 10.25,
  sellingPrice: 15,
  batchNo: randomUUID(),
  expiryDate: "2028-01-01T00:00:00.000Z",
  ...overrides,
});
async function draft(rows = [row()]) {
  return prisma.productImport.create({
    data: {
      tenantId: fx.tenantId,
      branchId: fx.mainBranchId,
      createdBy: fx.managerId,
      filename: "stock.csv",
      stockStaged: true,
      stagedStock: rows as never,
      status: "completed",
    },
  });
}
const read = (id: string, actor = user()) =>
  drafts.read(actor, fx.mainBranchId, id);
const post = (id: string, version = 1, categoryName?: string | null) =>
  drafts.post(user(), fx.mainBranchId, id, {
    version,
    ...(categoryName !== undefined ? { categoryName } : {}),
  });

beforeAll(async () => {
  fx = await createTenant(prisma, "import-stock");
  await prisma.userBranchRole.createMany({
    data: [
      {
        tenantId: fx.tenantId,
        branchId: fx.mainBranchId,
        userId: fx.ownerId,
        role: "owner",
      },
      {
        tenantId: fx.tenantId,
        branchId: fx.mainBranchId,
        userId: fx.managerId,
        role: "manager",
      },
      {
        tenantId: fx.tenantId,
        branchId: fx.mainBranchId,
        userId: fx.clerkId,
        role: "inventory_clerk",
      },
    ],
  });
});
afterAll(() => prisma.$disconnect());
afterEach(() => jest.restoreAllMocks());

it("only offers legacy physical undo at its selected non-live branch", async () => {
  const { service, record } = await importer("not_live");
  const here = (
    await service.listImports(fx.tenantId, 50, fx.mainBranchId)
  ).find((r) => r.id === record.id)!;
  expect(here).toMatchObject({ canUndo: true, stockUndo: true });
  const elsewhere = (
    await service.listImports(fx.tenantId, 50, fx.otherBranchId)
  ).find((r) => r.id === record.id)!;
  expect(elsewhere.canUndo).toBe(false);
  expect(elsewhere.undoBlockedReason).toMatch(/Switch/);
  await prisma.branch.update({
    where: { id: fx.mainBranchId },
    data: { desktopPosRollout: "live", desktopPosLiveAt: new Date() },
  });
  const live = (
    await service.listImports(fx.tenantId, 50, fx.mainBranchId)
  ).find((r) => r.id === record.id)!;
  expect(live.canUndo).toBe(false);
  expect(live.undoBlockedReason).toMatch(/counter/);
});

it("rolls back posting if executor permission is removed during an actual product lock wait", async () => {
  const saved = await draft();
  let release!: () => void;
  let ready!: (pid: number) => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const acquired = new Promise<number>((resolve) => {
    ready = resolve;
  });
  const blocker = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM product WHERE id = ${fx.productId}::uuid FOR UPDATE`;
      const pids = await tx.$queryRaw<
        { pid: number }[]
      >`SELECT pg_backend_pid() AS pid`;
      ready(pids[0]!.pid);
      await gate;
    },
    { timeout: 30_000 },
  );
  const pid = await acquired;
  const outcome = Promise.allSettled([
    drafts.post(user(fx.managerId), fx.mainBranchId, saved.id, { version: 1 }),
  ]);
  try {
    let waited = false;
    for (let i = 0; i < 100; i++) {
      const waits = await prisma.$queryRaw<
        { waiting: boolean }[]
      >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${pid}::integer = ANY(pg_blocking_pids(pid))) AS waiting`;
      if (waits[0]!.waiting) {
        waited = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(waited).toBe(true);
    await prisma.userBranchRole.updateMany({
      where: { tenantId: fx.tenantId, userId: fx.managerId },
      data: { role: "cashier" },
    });
    release();
    await blocker;
    expect((await outcome)[0]!.status).toBe("rejected");
    expect((await read(saved.id)).rows.every((r) => !r.postedBatchId)).toBe(
      true,
    );
    expect(
      await prisma.stockLedger.count({
        where: { tenantId: fx.tenantId, referenceId: saved.id },
      }),
    ).toBe(0);
  } finally {
    release();
    await Promise.allSettled([blocker, outcome]);
    await prisma.userBranchRole.updateMany({
      where: { tenantId: fx.tenantId, userId: fx.managerId },
      data: { role: "manager" },
    });
  }
});

it("replaces drafts without creating batches, stock, totals or reservations; stale posting fails", async () => {
  const saved = await draft();
  const material = [row({ qty: 7 })];
  const next = await drafts.replace(user(), fx.mainBranchId, saved.id, {
    version: 1,
    rows: material,
  });
  expect(next.version).toBe(2);
  expect(
    await prisma.stockLedger.count({
      where: { tenantId: fx.tenantId, referenceId: saved.id },
    }),
  ).toBe(0);
  expect(
    await prisma.batch.count({
      where: { tenantId: fx.tenantId, batchNo: material[0]!.batchNo },
    }),
  ).toBe(0);
  expect(
    await prisma.stockReservation.count({ where: { tenantId: fx.tenantId } }),
  ).toBe(0);
  await expect(post(saved.id)).rejects.toThrow(/changed/);
  await post(saved.id, 2);
  expect(
    (await prisma.productImport.findUniqueOrThrow({ where: { id: saved.id } }))
      .unitsPosted,
  ).toBe(7);
});

it("posts one category per atomic chunk, replays saved IDs and rejects replacement after any posting", async () => {
  const saved = await draft([
    row(),
    row({ rowNumber: 3, categoryName: "Retail", qty: 3 }),
  ]);
  const first = await post(saved.id, 1, "Medicines");
  expect(first.rows.filter((r) => r.postedBatchId)).toHaveLength(1);
  await expect(
    drafts.replace(user(), fx.mainBranchId, saved.id, {
      version: 1,
      rows: [row()],
    }),
  ).rejects.toThrow(/already posted/);
  const replay = await post(saved.id, 1, "Medicines");
  expect(replay).toEqual(first);
  await post(saved.id);
  const record = await prisma.productImport.findUniqueOrThrow({
    where: { id: saved.id },
  });
  expect(record.unitsPosted).toBe(15);
  expect(record.stockVersion).toBe(1);
  expect(
    await prisma.stockLedger.count({
      where: { tenantId: fx.tenantId, referenceId: saved.id },
    }),
  ).toBe(2);
  const events = await prisma.auditEvent.findMany({
    where: {
      tenantId: fx.tenantId,
      entityId: saved.id,
      eventName: "products.import_stock_posted",
    },
  });
  expect(events).toHaveLength(2);
  expect(events[0]!.actorUserId).toBe(fx.ownerId);
  expect(events[0]!.payload).toMatchObject({
    stagedBy: fx.managerId,
    executor: fx.ownerId,
  });
});

it("serializes concurrent retries into one stock effect", async () => {
  const saved = await draft();
  const [a, b] = await Promise.all([post(saved.id), post(saved.id)]);
  expect(a).toEqual(b);
  expect(
    await prisma.stockLedger.count({
      where: { tenantId: fx.tenantId, referenceId: saved.id },
    }),
  ).toBe(1);
});

it("rolls back every batch, stock total and posting marker on audit failure", async () => {
  const saved = await draft([row(), row({ rowNumber: 3 })]);
  jest
    .spyOn(audit, "log")
    .mockRejectedValueOnce(new Error("audit unavailable"));
  await expect(post(saved.id)).rejects.toThrow(/audit unavailable/);
  expect((await read(saved.id)).rows.every((r) => !r.postedBatchId)).toBe(true);
  expect(
    await prisma.stockLedger.count({
      where: { tenantId: fx.tenantId, referenceId: saved.id },
    }),
  ).toBe(0);
  for (const r of saved.stagedStock as unknown as StagedStockRow[])
    expect(
      await prisma.batch.count({
        where: { tenantId: fx.tenantId, batchNo: r.batchNo },
      }),
    ).toBe(0);
  await post(saved.id);
});

it("invalidates internal material edits and change-then-revert; freezes posted material", async () => {
  const material = [row()];
  const saved = await draft(material);
  await prisma.productImport.update({
    where: { id: saved.id },
    data: { stagedStock: [{ ...material[0]!, qty: 10 }] },
  });
  await prisma.productImport.update({
    where: { id: saved.id },
    data: { stagedStock: material as never },
  });
  expect((await read(saved.id)).version).toBe(3);
  await expect(post(saved.id)).rejects.toThrow(/changed/);
  await post(saved.id, 3);
  await expect(
    prisma.productImport.update({
      where: { id: saved.id },
      data: { stagedStock: [{ ...material[0]!, qty: 9 }] },
    }),
  ).rejects.toThrow(/immutable/);
});

it("hides cross-branch imports and rejects cross-tenant replacement products", async () => {
  const saved = await draft();
  await expect(drafts.read(user(), fx.otherBranchId, saved.id)).rejects.toThrow(
    /not found/,
  );
  const other = await createTenant(prisma, "other-import");
  await expect(
    drafts.replace(user(), fx.mainBranchId, saved.id, {
      version: 1,
      rows: [row({ productId: other.productId })],
    }),
  ).rejects.toThrow(/unavailable/);
});

it("redacts saved cost for an import-only role while letting it post server-held costs", async () => {
  const role = await prisma.role.create({
    data: {
      tenantId: fx.tenantId,
      key: `importer-${randomUUID()}`,
      name: "Importer",
      permissions: {
        create: { tenantId: fx.tenantId, permissionKey: "products.import" },
      },
    },
  });
  await prisma.userBranchRole.updateMany({
    where: { tenantId: fx.tenantId, userId: fx.clerkId },
    data: { role: "custom", roleId: role.id },
  });
  const saved = await draft();
  expect(
    (await read(saved.id, user(fx.clerkId))).rows[0]!.costPrice,
  ).toBeNull();
  await expect(
    drafts.replace(user(fx.clerkId), fx.mainBranchId, saved.id, {
      version: 1,
      rows: [row()],
    }),
  ).rejects.toThrow(/Cost access/);
  const result = await drafts.post(
    user(fx.clerkId),
    fx.mainBranchId,
    saved.id,
    { version: 1 },
  );
  expect(result.rows[0]!.costPrice).toBeNull();
  const batch = await prisma.batch.findUniqueOrThrow({
    where: { id: result.rows[0]!.postedBatchId! },
  });
  expect(batch.costPrice.toString()).toBe("10.25");
});

async function importer(rollout: "live" | "not_live", fallback = false) {
  await prisma.branch.update({
    where: { id: fx.mainBranchId },
    data: {
      desktopPosRollout: rollout,
      desktopPosLiveAt: rollout === "live" ? new Date() : null,
      posFallbackStartedAt: fallback ? new Date() : null,
      posFallbackEndsAt: fallback ? new Date(Date.now() + 600_000) : null,
    },
  });
  let run: (() => Promise<void>) | undefined;
  const runner = {
    start: (
      _jobId: string,
      _tenantId: string,
      id: string,
      work: (ctx: unknown) => Promise<void>,
    ) => {
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
    workers,
  );
  const file = {
    buffer: Buffer.from(
      `Name,Qty,Cost,Sell,Batch\nImported ${randomUUID()},5,8,12,${randomUUID()}\n`,
    ),
    originalname: "opening.csv",
  } as Express.Multer.File;
  const started = await service.startImport(
    fx.tenantId,
    { userId: fx.managerId, tokenVersion: 0 },
    fx.mainBranchId,
    file,
    {
      name: "Name",
      qty: "Qty",
      costPrice: "Cost",
      sellingPrice: "Sell",
      batchNo: "Batch",
    },
    [],
    {},
    randomUUID(),
  );
  await run!();
  return {
    service,
    record: await prisma.productImport.findUniqueOrThrow({
      where: { id: started.importId },
    }),
  };
}

it.each([false, true])(
  "live imports stage instead of posting, including fallback=%s",
  async (fallback) => {
    const { record } = await importer("live", fallback);
    expect(record.stockStaged).toBe(true);
    expect(record.unitsPosted).toBe(0);
    expect(record.result).toMatchObject({ unitsStaged: 5, unitsPosted: 0 });
    expect(
      await prisma.stockLedger.count({
        where: { tenantId: fx.tenantId, referenceId: record.id },
      }),
    ).toBe(0);
    expect(
      await prisma.batch.count({
        where: {
          tenantId: fx.tenantId,
          batchNo: (record.stagedStock as unknown as StagedStockRow[])[0]!
            .batchNo,
        },
      }),
    ).toBe(0);
  },
);

it("retains legacy non-live import and physical undo while remote undo cannot delete stock", async () => {
  const { service, record } = await importer("not_live");
  expect(record.unitsPosted).toBe(5);
  await expect(
    service.undo(
      fx.tenantId,
      fx.ownerId,
      record.id,
      false,
      undefined,
      (tx, branchId) => drafts.authorizeUndo(user(), undefined, tx, branchId),
    ),
  ).rejects.toThrow(/counter/);
  await service.undo(
    fx.tenantId,
    fx.ownerId,
    record.id,
    true,
    fx.mainBranchId,
    (tx) => drafts.authorize(user(), fx.mainBranchId, tx),
  );
  expect(
    (await prisma.productImport.findUniqueOrThrow({ where: { id: record.id } }))
      .status,
  ).toBe("undone");
});

it("retains posted draft history and refuses undo after stock moves", async () => {
  const saved = await draft();
  const posted = await post(saved.id);
  const batchId = posted.rows[0]!.postedBatchId!;
  await prisma.$transaction((tx) =>
    stock.issue(
      tx,
      {
        tenantId: fx.tenantId,
        branchId: fx.mainBranchId,
        userId: fx.ownerId,
        referenceType: "sale",
        referenceId: randomUUID(),
      },
      [
        {
          productId: fx.productId,
          batchId,
          qty: 1,
          movementType: StockMovementType.sale_out,
        },
      ],
    ),
  );
  const service = new ProductImportService(
    proxy as never,
    audit,
    {} as never,
    {} as never,
    {} as never,
    stock,
    workers,
  );
  await expect(
    service.undo(
      fx.tenantId,
      fx.ownerId,
      saved.id,
      true,
      fx.mainBranchId,
      (tx) => drafts.authorize(user(), fx.mainBranchId, tx),
    ),
  ).rejects.toThrow(/sold or moved|adjustment/);
  expect(
    await prisma.stockLedger.count({
      where: { tenantId: fx.tenantId, batchId },
    }),
  ).toBe(2);
});

it.each([false, true])(
  "rechecks undo rights after actual category cascade lock wait (stock=%s)",
  async (physical) => {
    const saved = await prisma.productImport.create({
      data: {
        tenantId: fx.tenantId,
        createdBy: fx.managerId,
        branchId: physical ? fx.mainBranchId : null,
        status: "completed",
        filename: "cascade.csv",
      },
    });
    const product = await prisma.product.create({
      data: {
        tenantId: fx.tenantId,
        sku: randomUUID(),
        name: "Cascade import",
        importId: saved.id,
      },
    });
    const category = await prisma.productCategory.create({
      data: {
        tenantId: fx.tenantId,
        name: randomUUID(),
        dimension: "COMMERCIAL",
      },
    });
    const map = await prisma.productCategoryMap.create({
      data: {
        tenantId: fx.tenantId,
        productId: product.id,
        categoryId: category.id,
        dimension: "COMMERCIAL",
      },
    });
    if (physical) {
      const batch = await prisma.batch.create({
        data: {
          tenantId: fx.tenantId,
          branchId: fx.mainBranchId,
          productId: product.id,
          batchNo: randomUUID(),
          expiryDate: new Date("2028-01-01"),
          costPrice: 1,
          sellingPrice: 2,
        },
      });
      await prisma.$transaction((tx) =>
        stock.receive(
          tx,
          {
            tenantId: fx.tenantId,
            branchId: fx.mainBranchId,
            userId: fx.managerId,
            referenceType: "product_import",
            referenceId: saved.id,
          },
          [
            {
              productId: product.id,
              batchId: batch.id,
              qty: 3,
              movementType: StockMovementType.opening_stock,
            },
          ],
        ),
      );
    }
    let release!: () => void;
    let ready!: (pid: number) => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = new Promise<number>((resolve) => {
      ready = resolve;
    });
    const blocker = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM product_category_map WHERE id = ${map.id}::uuid FOR UPDATE`;
        const pids = await tx.$queryRaw<
          { pid: number }[]
        >`SELECT pg_backend_pid() AS pid`;
        ready(pids[0]!.pid);
        await gate;
      },
      { timeout: 30_000 },
    );
    const pid = await acquired;
    const service = new ProductImportService(
      proxy as never,
      audit,
      {} as never,
      {} as never,
      {} as never,
      stock,
      workers,
    );
    const outcome = Promise.allSettled([
      service.undo(
        fx.tenantId,
        fx.managerId,
        saved.id,
        physical,
        physical ? fx.mainBranchId : undefined,
        (tx, branchId) =>
          drafts.authorizeUndo(
            user(fx.managerId),
            fx.mainBranchId,
            tx,
            branchId,
          ),
      ),
    ]);
    try {
      let waited = false;
      for (let i = 0; i < 100; i++) {
        const waits = await prisma.$queryRaw<
          { waiting: boolean }[]
        >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${pid}::integer = ANY(pg_blocking_pids(pid))) AS waiting`;
        if (waits[0]!.waiting) {
          waited = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waited).toBe(true);
      await prisma.userBranchRole.updateMany({
        where: { tenantId: fx.tenantId, userId: fx.managerId },
        data: { role: "cashier" },
      });
      release();
      await blocker;
      expect((await outcome)[0]!.status).toBe("rejected");
      expect(
        (
          await prisma.productImport.findUniqueOrThrow({
            where: { id: saved.id },
          })
        ).status,
      ).toBe("completed");
      expect(await prisma.product.count({ where: { id: product.id } })).toBe(1);
      expect(
        await prisma.productCategoryMap.count({ where: { id: map.id } }),
      ).toBe(1);
      expect(
        await prisma.auditEvent.count({
          where: {
            tenantId: fx.tenantId,
            entityId: saved.id,
            eventName: "products.import_undone",
          },
        }),
      ).toBe(0);
      if (physical)
        expect(
          await prisma.stockLedger.count({
            where: { tenantId: fx.tenantId, referenceId: saved.id },
          }),
        ).toBe(1);
    } finally {
      release();
      await Promise.allSettled([blocker, outcome]);
      await prisma.userBranchRole.updateMany({
        where: { tenantId: fx.tenantId, userId: fx.managerId },
        data: { role: "manager" },
      });
    }
  },
);
