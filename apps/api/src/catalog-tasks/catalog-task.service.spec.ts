import type { AuditService } from "../audit/audit.service";
import type { CategoryTaxonomyService } from "../catalog/category-taxonomy.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { ProductNmraLinkService } from "../products/product-nmra-link.service";
import { CatalogTaskService, confidenceForEvidence } from "./catalog-task.service";

/**
 * A minimal in-memory `catalogTask` table. The lifecycle rules — which rows a refresh may
 * overwrite, what a dismissal does — are the reason this service exists, so they are tested
 * against something that actually stores rows rather than a bare jest.fn().
 */
function makeTaskStore(seed: Array<Record<string, unknown>> = []) {
  const rows = seed.map((r) => ({ ...r }));
  return {
    rows,
    model: {
      findMany: jest.fn(async ({ where, select }: never) => filter(rows, where, select)),
      findFirst: jest.fn(async ({ where }: never) => filter(rows, where)[0] ?? null),
      count: jest.fn(async ({ where }: never) => filter(rows, where).length),
      create: jest.fn(async ({ data }: never) => {
        const row = { id: `task-${rows.length + 1}`, ...(data as object) };
        rows.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: never) => {
        const row = rows.find((r) => r.id === (where as { id: string }).id);
        Object.assign(row!, data as object);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: never) => {
        const hits = filter(rows, where);
        for (const row of hits) Object.assign(row, data as object);
        return { count: hits.length };
      }),
    },
  };
}

/** Supports only the handful of Prisma filter shapes the service actually builds. */
function filter(
  rows: Array<Record<string, unknown>>,
  where: Record<string, unknown> = {},
  _select?: unknown,
): Array<Record<string, unknown>> {
  return rows.filter((row) =>
    Object.entries(where).every(([key, cond]) => {
      if (["tenantId", "product", "import"].includes(key)) return true;
      if (cond === null) return row[key] == null;
      if (typeof cond === "object" && cond !== null) {
        const c = cond as Record<string, unknown>;
        if ("in" in c) return (c.in as unknown[]).includes(row[key]);
        if ("notIn" in c) return !(c.notIn as unknown[]).includes(row[key]);
        return true;
      }
      return row[key] === cond;
    }),
  );
}

function makeService(store: ReturnType<typeof makeTaskStore>) {
  const link = { link: jest.fn() } as unknown as ProductNmraLinkService;
  const taxonomy = {
    setPrimaryCommercialCategory: jest.fn(),
    commercialCanonicalIds: jest.fn().mockResolvedValue(new Map()),
  } as unknown as CategoryTaxonomyService;
  const audit = { log: jest.fn() } as unknown as AuditService;
  const prisma = {
    catalogTask: store.model,
    product: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    productCategory: {
      findFirst: jest.fn().mockResolvedValue({ id: "cat-1" }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    productCategoryMap: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as PrismaService;

  return { service: new CatalogTaskService(prisma, taxonomy, link, audit), link, taxonomy, audit };
}

function task(over: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    tenantId: "t1",
    productId: "p1",
    type: "NMRA_MATCH",
    status: "OPEN",
    suggestion: { referenceProductId: "ref-1" },
    evidence: "registration",
    confidence: 0.98,
    complianceImpact: false,
    safeToApply: true,
    candidates: [],
    importId: null,
    sourceRow: null,
    createdAt: new Date("2026-09-01"),
    resolvedAt: null,
    resolvedByUserId: null,
    resolutionNote: null,
    product: {
      id: "p1",
      name: "Amlodipine 5mg Tablet",
      sku: "SKU1",
      brandName: "Norvasc",
      genericName: "Amlodipine",
      dosageForm: "Tablet",
      strength: "5mg",
      barcode: null,
      registrationNo: null,
      source: "MANUAL",
      isControlled: false,
      requiresPrescription: false,
    },
    import: null,
    resolvedBy: null,
    ...over,
  };
}

describe("CatalogTaskService — lifecycle", () => {
  const tenantId = "t1";
  const userId = "u1";

  /**
   * The single behaviour that makes the queue different from the two screens it replaces:
   * those recomputed their list on every load, so "this umbrella is not a medicine" survived
   * exactly until the next page load and the same question came back forever.
   */
  it("a dismissal sticks — the task leaves the open queue and records who closed it", async () => {
    const store = makeTaskStore([task()]);
    const { service, audit } = makeService(store);

    await service.dismiss(tenantId, userId, "task-1", "Not a medicine.");

    expect(store.rows[0]).toMatchObject({
      status: "DISMISSED",
      resolvedByUserId: userId,
      resolutionNote: "Not a medicine.",
    });
    expect(store.rows[0].resolvedAt).toBeInstanceOf(Date);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: "catalog_task.dismissed" }),
    );
  });

  it("marking not applicable is the same durable decision under a different name", async () => {
    const store = makeTaskStore([task()]);
    const { service } = makeService(store);

    await service.markNotApplicable(tenantId, userId, "task-1", "Kitchen scale.");

    expect(store.rows[0]).toMatchObject({ status: "NOT_APPLICABLE", resolvedByUserId: userId });
  });

  it("reopening clears the closure so the task is workable again", async () => {
    const store = makeTaskStore([
      task({ status: "DISMISSED", resolvedByUserId: userId, resolvedAt: new Date(), resolutionNote: "x" }),
    ]);
    const { service } = makeService(store);

    await service.reopen(tenantId, userId, "task-1");

    expect(store.rows[0]).toMatchObject({
      status: "OPEN",
      resolvedAt: null,
      resolvedByUserId: null,
      resolutionNote: null,
    });
  });

  it("reopening a compliance-sensitive task returns it to review, not to plain open", async () => {
    const store = makeTaskStore([task({ status: "DISMISSED", complianceImpact: true })]);
    const { service } = makeService(store);

    await service.reopen(tenantId, userId, "task-1");

    expect(store.rows[0].status).toBe("NEEDS_REVIEW");
  });

  it("refuses to apply a task that is already resolved", async () => {
    const store = makeTaskStore([task({ status: "RESOLVED" })]);
    const { service } = makeService(store);

    await expect(service.apply(tenantId, userId, "task-1")).rejects.toThrow(
      /already been resolved/,
    );
  });

  it("rejects an unknown task id rather than silently doing nothing", async () => {
    const { service } = makeService(makeTaskStore([]));
    await expect(service.dismiss(tenantId, userId, "nope")).rejects.toThrow(/not found/i);
  });
});

describe("CatalogTaskService — applying", () => {
  const tenantId = "t1";
  const userId = "u1";

  /**
   * Applying an NMRA task must not be a second implementation of linking. The field-ownership
   * policy, the undo snapshot and the audit entry all live in the link service, and a task
   * that wrote `nmraReferenceId` itself would skip every one of them.
   */
  it("links through the link service rather than writing the product itself", async () => {
    const store = makeTaskStore([task()]);
    const { service, link } = makeService(store);

    await service.apply(tenantId, userId, "task-1");

    expect(link.link).toHaveBeenCalledWith(tenantId, userId, "p1", "ref-1");
    expect(store.rows[0].status).toBe("RESOLVED");
  });

  it("honours an operator's choice of a different register entry", async () => {
    const store = makeTaskStore([task()]);
    const { service, link } = makeService(store);

    await service.apply(tenantId, userId, "task-1", { referenceProductId: "ref-other" });

    expect(link.link).toHaveBeenCalledWith(tenantId, userId, "p1", "ref-other");
  });

  it("refuses an NMRA task with nothing to apply and no override", async () => {
    const store = makeTaskStore([task({ suggestion: null })]);
    const { service } = makeService(store);

    await expect(service.apply(tenantId, userId, "task-1")).rejects.toThrow(
      /Choose a register entry/,
    );
  });

  it("applies a category task through the taxonomy service", async () => {
    const store = makeTaskStore([
      task({ type: "MISSING_CATEGORY", suggestion: { categoryId: "cat-1" }, evidence: "generic_rule" }),
    ]);
    const { service, taxonomy } = makeService(store);

    await service.apply(tenantId, userId, "task-1");

    expect(taxonomy.setPrimaryCommercialCategory).toHaveBeenCalledWith(
      tenantId,
      "p1",
      "cat-1",
      { assignmentSource: "MANUAL" },
    );
  });

  it("refuses a category task with no suggestion and no chosen category", async () => {
    const store = makeTaskStore([task({ type: "MISSING_CATEGORY", suggestion: null })]);
    const { service } = makeService(store);

    await expect(service.apply(tenantId, userId, "task-1")).rejects.toThrow(/Choose a category/);
  });

  /** The bulk button must touch only rows that passed the safety rule, never the queue at large. */
  it("apply-safe applies only tasks flagged safe", async () => {
    const store = makeTaskStore([
      task({ id: "safe-1", safeToApply: true }),
      task({ id: "unsafe-1", safeToApply: false, complianceImpact: true, status: "NEEDS_REVIEW" }),
    ]);
    const { service, link } = makeService(store);

    const result = await service.applySafe(tenantId, userId, {});

    expect(result.applied).toBe(1);
    expect(link.link).toHaveBeenCalledTimes(1);
    expect(store.rows.find((r) => r.id === "unsafe-1")!.status).toBe("NEEDS_REVIEW");
  });

  it("apply-safe reports a failure instead of aborting the rest of the batch", async () => {
    const store = makeTaskStore([
      task({ id: "safe-1", safeToApply: true }),
      task({ id: "safe-2", safeToApply: true, productId: "p2" }),
    ]);
    const { service, link } = makeService(store);
    (link.link as jest.Mock)
      .mockRejectedValueOnce(new Error("That register entry is already linked."))
      .mockResolvedValueOnce({});

    const result = await service.applySafe(tenantId, userId, {});

    expect(result.applied).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].reason).toContain("already linked");
  });
});

describe("confidenceForEvidence", () => {
  it("ranks exact identifiers above resemblances", () => {
    expect(confidenceForEvidence("barcode")!).toBeGreaterThan(confidenceForEvidence("normalized")!);
    expect(confidenceForEvidence("normalized")!).toBeGreaterThan(confidenceForEvidence("fuzzy")!);
    expect(confidenceForEvidence("fuzzy")!).toBeGreaterThan(confidenceForEvidence("inn_head")!);
  });

  it("has no number for an absent evidence tier", () => {
    expect(confidenceForEvidence(null)).toBeNull();
    expect(confidenceForEvidence("something-else")).toBeNull();
  });
});
