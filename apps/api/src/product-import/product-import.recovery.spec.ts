import { ProductImportService } from "./product-import.service";
import { createTenantAwarePrismaProxy } from "../prisma/tenant-aware-prisma.proxy";

function setup() {
  let row: any = {
    id: "import",
    tenantId: "tenant",
    branchId: "branch",
    status: "running",
    productsUpdated: 2,
  };
  const events: string[] = [];
  const root: any = {
    productImport: {
      findFirst: jest.fn(async () => row),
      updateMany: jest.fn(async ({ where, data }) => {
        if (where.status && row.status !== where.status) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    product: {
      findFirst: jest.fn(async () => null),
      deleteMany: jest.fn(async () => ({ count: 3 })),
    },
    batch: { deleteMany: jest.fn(async () => ({ count: 1 })) },
    stockLedger: {
      findMany: jest.fn(async () => [{ batchId: "batch" }]),
      findFirst: jest.fn(async () => {
        events.push("history");
        return null;
      }),
      deleteMany: jest.fn(async () => {
        events.push("delete");
        return { count: 1 };
      }),
    },
    $queryRaw: jest.fn(async () => {
      events.push("lock");
      return [];
    }),
    $executeRaw: jest.fn(async () => 1),
  };
  root.$transaction = jest.fn(async (work) => {
    const before = { ...row };
    try {
      return await work(root);
    } catch (e) {
      row = before;
      throw e;
    }
  });
  const audit = { log: jest.fn(async () => {}) };
  const service: any = new ProductImportService(
    createTenantAwarePrismaProxy(root) as never,
    audit as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, root, audit, events, getRow: () => row };
}

describe("import recovery boundaries", () => {
  it("fences a late worker after its import was stopped or undone", async () => {
    const { service, getRow } = setup();
    getRow().status = "undone";
    const work = jest.fn();
    await expect(
      service.inImportTransaction("tenant", "import", work),
    ).rejects.toThrow(/Import stopped/);
    expect(work).not.toHaveBeenCalled();
  });
  it("allows guarded undo of a partial failed import and retains matched products", async () => {
    const { service, root, getRow, events } = setup();
    getRow().status = "failed";
    const result = await service.undo("tenant", "user", "import");
    expect(result).toMatchObject({
      productsLeftInPlace: 2,
      productsRemoved: 3,
      batchesRemoved: 1,
    });
    expect(root.product.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: "tenant", importId: "import" },
    });
    expect(events.slice(0, 4)).toEqual(["lock", "lock", "lock", "history"]);
    expect(getRow().status).toBe("undone");
  });
  it("rechecks stock activity after acquiring locks, before deleting anything", async () => {
    const { service, root, getRow } = setup();
    getRow().status = "failed";
    root.stockLedger.findFirst.mockResolvedValue({ id: "sale-movement" });
    await expect(service.undo("tenant", "user", "import")).rejects.toThrow(
      /sold or moved/,
    );
    expect(root.stockLedger.deleteMany).not.toHaveBeenCalled();
  });
  it("rejects undo while the worker is running", async () => {
    const { service, root } = setup();
    await expect(service.undo("tenant", "user", "import")).rejects.toThrow(
      /completed or stopped/,
    );
    expect(root.stockLedger.deleteMany).not.toHaveBeenCalled();
  });

  function prepareRun() {
    const ctx = { jobId: "import", importId: "import", progress: jest.fn() };
    const state = setup();
    const { service } = state;
    service.buildIndex = jest.fn();
    service.planRows = jest
      .fn()
      .mockReturnValue({ planned: [], issues: [], pendingCompliance: [] });
    service.writeProducts = jest
      .fn()
      .mockResolvedValue({
        created: 1,
        updated: 0,
        ranged: 0,
        processed: 1,
        productIdByRow: new Map([[601, "product"]]),
      });
    service.applyCategories = jest
      .fn()
      .mockResolvedValue({ fromFile: 0, byClassifier: 0, unclassified: 1 });
    service.generateCatalogTasks = jest
      .fn()
      .mockResolvedValue({
        total: 0,
        needsCategory: 0,
        nmraMatch: 0,
        complianceReview: 0,
        ambiguous: 0,
      });
    return { ...state, ctx };
  }
  it("keeps exact row counts above 500 and separates partial rows from rejected rows", async () => {
    const { service, ctx, getRow } = prepareRun();
    const issues = Array.from({ length: 601 }, (_, i) => ({
      rowNumber: i + 1,
      name: "p",
      message: "invalid",
    }));
    issues.push({
      rowNumber: 601,
      name: "p",
      message: "second problem on same row",
    });
    await service.runImport(
      ctx,
      "tenant",
      "user",
      null,
      "import",
      { rows: [], issues },
      new Set(),
      {},
    );
    expect(getRow().result).toMatchObject({
      rowsFailed: 600,
      rowsPartiallyImported: 1,
      rowsWithIssues: 601,
      issueCount: 602,
      issuesTruncated: true,
    });
    expect(getRow().result.issues).toHaveLength(500);
  });
  it("rolls back completion if its audit write fails, leaving committed work recoverable", async () => {
    const { service, ctx, audit, getRow } = prepareRun();
    audit.log.mockRejectedValue(new Error("audit unavailable"));
    await expect(
      service.runImport(
        ctx,
        "tenant",
        "user",
        null,
        "import",
        { rows: [], issues: [] },
        new Set(),
        {},
      ),
    ).rejects.toThrow(/audit unavailable/);
    expect(getRow().status).toBe("running");
    expect(getRow().result).toBeUndefined();
  });
});
