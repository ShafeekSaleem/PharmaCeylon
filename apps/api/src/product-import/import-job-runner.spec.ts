import { tenantTransactionStorage } from "../prisma/tenant-transaction.store";
import type { PrismaService } from "../prisma/prisma.service";
import { ImportJobRunner, INTERRUPTED_MESSAGE } from "./import-job-runner";

/**
 * An import must never sit in a lie.
 *
 * Jobs were tracked only in a process-local Map, so a deploy mid-import left the row `running`
 * forever with no way to tell whether it had finished or died, and a progress poll routed to a
 * second API instance answered 404 while the import ran happily on the first. These tests pin
 * the two halves of the fix: the stale sweep, and the database fallback for progress.
 */
describe("ImportJobRunner", () => {
  function makePrisma(overrides: Record<string, unknown> = {}) {
    return {
      productImport: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue(null),
        ...overrides,
      },
    } as unknown as PrismaService;
  }

  describe("sweepStale", () => {
    it("moves interrupted jobs to failed with a message an operator can act on", async () => {
      const prisma = makePrisma({
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      });
      const runner = new ImportJobRunner(prisma);

      const swept = await runner.sweepStale();

      expect(swept).toBe(2);
      const args = (prisma.productImport.updateMany as jest.Mock).mock
        .calls[0][0];
      expect(args.where.status).toBe("running");
      expect(args.data.status).toBe("failed");
      expect(args.data.error).toBe(INTERRUPTED_MESSAGE);
      // Says the products already created were kept — an operator who reads "failed" and
      // assumes nothing happened will double-import.
      expect(INTERRUPTED_MESSAGE).toContain("already created were kept");
    });

    it("covers rows that died before their first heartbeat, using createdAt as the clock", async () => {
      const prisma = makePrisma();
      const runner = new ImportJobRunner(prisma);

      await runner.sweepStale();

      const where = (prisma.productImport.updateMany as jest.Mock).mock
        .calls[0][0].where;
      expect(where.OR).toEqual([
        { heartbeatAt: { lt: expect.any(Date) } },
        { heartbeatAt: null, createdAt: { lt: expect.any(Date) } },
      ]);
    });

    it("survives a database failure rather than taking the process down with it", async () => {
      const prisma = makePrisma({
        updateMany: jest
          .fn()
          .mockRejectedValue(new Error("connection refused")),
      });
      const runner = new ImportJobRunner(prisma);

      await expect(runner.sweepStale()).resolves.toBe(0);
    });
  });

  it("returns the durable completion result after a restart", async () => {
    const result = { importId: "imp-result", productsCreated: 2 };
    const prisma = makePrisma({
      findFirst: jest.fn().mockResolvedValue({
        id: "imp-result",
        status: "completed",
        result,
        phase: "done",
      }),
    });
    expect(
      (await new ImportJobRunner(prisma).getProgress("t1", "imp-result"))
        .result,
    ).toEqual(result);
  });

  it("does not start work after the import was stopped", async () => {
    const prisma = makePrisma({
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    });
    const work = jest.fn();
    const runner = new ImportJobRunner(prisma);
    runner.start("stopped", "t1", "stopped", work);
    await new Promise((resolve) => setImmediate(resolve));
    expect(work).not.toHaveBeenCalled();
    runner.onModuleDestroy();
  });

  it("runs failure handling outside the request transaction too", async () => {
    const scopes: unknown[] = [];
    const prisma = makePrisma({
      updateMany: jest.fn(async () => {
        scopes.push(tenantTransactionStorage.getStore());
        return { count: 1 };
      }),
    });
    const runner = new ImportJobRunner(prisma);
    tenantTransactionStorage.run(
      { tenantId: "t1", client: {} as never },
      () => {
        runner.start("detached", "t1", "detached", async () => {
          throw new Error("interrupted");
        });
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(scopes.length).toBeGreaterThan(1);
    expect(scopes.every((scope) => scope === undefined)).toBe(true);
    runner.onModuleDestroy();
  });

  describe("getProgress", () => {
    /**
     * The cross-instance case. `jobId` and `importId` are the same value by construction, so a
     * job this process never saw is still answerable from its durable row.
     */
    it("answers from the database for a job this instance never ran", async () => {
      const prisma = makePrisma({
        findFirst: jest.fn().mockResolvedValue({
          id: "imp-1",
          status: "running",
          phase: "products",
          rowsProcessed: 120,
          rowsTotal: 400,
          productsCreated: 100,
          productsUpdated: 20,
          batchesCreated: 0,
          rowsFailed: 2,
          error: null,
        }),
      });
      const runner = new ImportJobRunner(prisma);

      const progress = await runner.getProgress("t1", "imp-1");

      expect(progress).toMatchObject({
        jobId: "imp-1",
        importId: "imp-1",
        status: "running",
        phase: "products",
        processed: 120,
        total: 400,
        errorCount: 2,
      });
    });

    it("reports a swept job as failed, carrying its reason", async () => {
      const prisma = makePrisma({
        findFirst: jest.fn().mockResolvedValue({
          id: "imp-1",
          status: "failed",
          phase: null,
          rowsProcessed: 50,
          rowsTotal: 400,
          productsCreated: 40,
          productsUpdated: 0,
          batchesCreated: 0,
          rowsFailed: 0,
          error: INTERRUPTED_MESSAGE,
        }),
      });
      const runner = new ImportJobRunner(prisma);

      const progress = await runner.getProgress("t1", "imp-1");

      expect(progress.status).toBe("failed");
      expect(progress.error).toBe(INTERRUPTED_MESSAGE);
    });

    it("404s for a job id that belongs to no import", async () => {
      const runner = new ImportJobRunner(makePrisma());
      await expect(runner.getProgress("t1", "nope")).rejects.toThrow(
        /not found/i,
      );
    });

    it("scopes the lookup by tenant, so one tenant cannot poll another's import", async () => {
      const prisma = makePrisma();
      const runner = new ImportJobRunner(prisma);

      await runner.getProgress("t1", "imp-1").catch(() => undefined);

      expect(
        (prisma.productImport.findFirst as jest.Mock).mock.calls[0][0].where,
      ).toEqual({
        id: "imp-1",
        tenantId: "t1",
      });
    });
  });

  describe("start", () => {
    it("captures a thrown error onto the import row instead of an unhandled rejection", async () => {
      const prisma = makePrisma();
      const runner = new ImportJobRunner(prisma);

      runner.start("job-1", "t1", "imp-1", async () => {
        throw new Error("row 42 is malformed");
      });
      // Let the rejection settle through the catch/finally chain.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      const failure = (
        prisma.productImport.updateMany as jest.Mock
      ).mock.calls.find((call) => call[0].data?.status === "failed");
      expect(failure?.[0].data.error).toBe("row 42 is malformed");
      runner.onModuleDestroy();
    });

    it("marks the row running as soon as the job starts", async () => {
      const prisma = makePrisma();
      const runner = new ImportJobRunner(prisma);

      runner.start("job-1", "t1", "imp-1", async () => undefined);
      await new Promise((resolve) => setImmediate(resolve));

      const running = (
        prisma.productImport.updateMany as jest.Mock
      ).mock.calls.find((call) => call[0].data?.phase === "starting");
      expect(running?.[0].data.heartbeatAt).toBeInstanceOf(Date);
      runner.onModuleDestroy();
    });
  });
});
