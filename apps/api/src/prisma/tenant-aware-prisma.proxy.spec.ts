import { tenantTransactionStorage } from "./tenant-transaction.store";
import { createTenantAwarePrismaProxy } from "./tenant-aware-prisma.proxy";

describe("createTenantAwarePrismaProxy", () => {
  const rootFind = jest.fn().mockResolvedValue(["root"]);
  const txFind = jest.fn().mockResolvedValue(["tenant"]);
  const rootTransaction = jest.fn();
  const root = {
    product: { findMany: rootFind },
    $transaction: rootTransaction,
  };
  const tx = {
    product: { findMany: txFind },
  };
  const prisma = createTenantAwarePrismaProxy(root);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("uses the root client outside a tenant transaction", async () => {
    await expect(prisma.product.findMany()).resolves.toEqual(["root"]);
    expect(rootFind).toHaveBeenCalled();
    expect(txFind).not.toHaveBeenCalled();
  });

  it("routes delegates to the active transaction client", async () => {
    await tenantTransactionStorage.run(
      { tenantId: "tenant-1", client: tx as never },
      async () => {
        await expect(prisma.product.findMany()).resolves.toEqual(["tenant"]);
      },
    );

    expect(txFind).toHaveBeenCalled();
    expect(rootFind).not.toHaveBeenCalled();
  });

  it("reuses the active transaction for callback transactions", async () => {
    await tenantTransactionStorage.run(
      { tenantId: "tenant-1", client: tx as never },
      async () => {
        const result = await prisma.$transaction(async (client: unknown) => {
          expect(client).toBe(tx);
          return "ok";
        });
        expect(result).toBe("ok");
      },
    );

    expect(rootTransaction).not.toHaveBeenCalled();
  });

  it("resolves array transactions inside the active outer transaction", async () => {
    await tenantTransactionStorage.run(
      { tenantId: "tenant-1", client: tx as never },
      async () => {
        await expect(prisma.$transaction([Promise.resolve(1), Promise.resolve(2)])).resolves.toEqual([
          1,
          2,
        ]);
      },
    );

    expect(rootTransaction).not.toHaveBeenCalled();
  });
});
