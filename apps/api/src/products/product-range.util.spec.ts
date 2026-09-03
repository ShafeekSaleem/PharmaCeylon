import { ensureProductsRanged } from "./product-range.util";

/**
 * Stock must never exist against a product the shop has not ranged, so every "stock arrives"
 * path promotes through this helper. The promotion is deliberately one-way and REFERENCE-only.
 */
describe("ensureProductsRanged", () => {
  const tenantId = "tenant-1";

  function makeClient(count = 1) {
    return {
      product: { updateMany: jest.fn().mockResolvedValue({ count }) },
    };
  }

  it("promotes only REFERENCE rows, scoped to the tenant", async () => {
    const client = makeClient(2);

    const promoted = await ensureProductsRanged(client as never, tenantId, ["p1", "p2"]);

    const call = client.product.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({
      tenantId,
      id: { in: ["p1", "p2"] },
      rangeStatus: "REFERENCE",
    });
    expect(call.data.rangeStatus).toBe("RANGED");
    expect(promoted).toBe(2);
  });

  it("never re-enables a product the pharmacist deactivated", async () => {
    const client = makeClient();

    await ensureProductsRanged(client as never, tenantId, ["p1"]);

    expect(client.product.updateMany.mock.calls[0][0].data).not.toHaveProperty("isActive");
  });

  it("de-duplicates ids and skips the query entirely when there is nothing to promote", async () => {
    const client = makeClient();

    await ensureProductsRanged(client as never, tenantId, ["p1", "p1"]);
    expect(client.product.updateMany.mock.calls[0][0].where.id).toEqual({ in: ["p1"] });

    client.product.updateMany.mockClear();
    await expect(ensureProductsRanged(client as never, tenantId, [])).resolves.toBe(0);
    expect(client.product.updateMany).not.toHaveBeenCalled();
  });
});
