import { TenantTransactionContext } from "./tenant-transaction-context.service";

describe("TenantTransactionContext", () => {
  const tx = {
    $executeRawUnsafe: jest.fn().mockResolvedValue(1),
  };
  const root = {
    $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) =>
      callback(tx),
    ),
  };
  let context: TenantTransactionContext;

  beforeEach(() => {
    jest.clearAllMocks();
    context = new TenantTransactionContext(root as never);
  });

  it("sets transaction-local tenant and branch context before running work", async () => {
    const result = await context.run(
      { tenantId: "tenant-1", branchId: "branch-1" },
      async (client) => {
        expect(client).toBe(tx);
        expect(context.client).toBe(tx);
        expect(context.scope).toEqual({ tenantId: "tenant-1", branchId: "branch-1" });
        return "ok";
      },
    );

    expect(result).toBe("ok");
    expect(tx.$executeRawUnsafe).toHaveBeenNthCalledWith(
      1,
      "SELECT set_config('app.tenant_id', $1, true)",
      "tenant-1",
    );
    expect(tx.$executeRawUnsafe).toHaveBeenNthCalledWith(
      2,
      "SELECT set_config('app.branch_id', $1, true)",
      "branch-1",
    );
    expect(context.isActive).toBe(false);
    expect(context.client).toBe(root);
  });

  it("uses an empty branch setting for tenant-wide work", async () => {
    await context.run({ tenantId: "tenant-1" }, async () => undefined);

    expect(tx.$executeRawUnsafe).toHaveBeenNthCalledWith(
      2,
      "SELECT set_config('app.branch_id', $1, true)",
      "",
    );
  });

  it("reuses a matching nested tenant transaction", async () => {
    await context.run({ tenantId: "tenant-1" }, async (outerClient) => {
      await context.run({ tenantId: "tenant-1" }, async (innerClient) => {
        expect(innerClient).toBe(outerClient);
      });
    });

    expect(root.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it("rejects tenant or branch changes inside an active transaction", async () => {
    await expect(
      context.run({ tenantId: "tenant-1", branchId: "branch-1" }, async () =>
        context.run({ tenantId: "tenant-2", branchId: "branch-1" }, async () => undefined),
      ),
    ).rejects.toThrow("Cannot change tenant or branch");
  });

  it("clears AsyncLocalStorage after failed work", async () => {
    await expect(
      context.run({ tenantId: "tenant-1" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(context.isActive).toBe(false);
    expect(context.scope).toBeNull();
  });

  it("rejects an empty tenant id before opening a transaction", async () => {
    await expect(context.run({ tenantId: "  " }, async () => undefined)).rejects.toThrow(
      "requires tenantId",
    );
    expect(root.$transaction).not.toHaveBeenCalled();
  });
});
