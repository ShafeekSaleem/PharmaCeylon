import { randomUUID } from "node:crypto";
import { ApiError, type ApiSession } from "../api/api-client";
import type { SignedCommandService } from "./signed-commands";
import { StockLookupService } from "./stock-lookup";
import type { TerminalService } from "./terminal-service";

const branchId = randomUUID();
const productId = randomUUID();
const batchId = randomUUID();

const item = (overrides: Record<string, unknown> = {}) => ({
  productId,
  qtyOnHand: 10,
  availableQty: 8,
  quarantinedQty: 2,
  reservedQty: 0,
  stockStatus: "ok",
  batchCount: 2,
  nearExpiryBatchCount: 1,
  expiredBatchCount: 0,
  nextExpiry: "2027-01-31",
  product: {
    id: productId,
    name: "Augmentin 625mg Tablets",
    strength: null,
    unit: "tab",
    manufacturer: "GSK",
    unitsPerPack: 14,
    packLabel: null,
    requiresPrescription: true,
    isControlled: false,
    reorderLevel: 20,
  },
  ...overrides,
});

function service(reply: (path: string) => unknown) {
  const calls: { method: string; path: string; branchId?: string }[] = [];
  const api = {
    request: async (method: string, path: string, opts: { branchId?: string } = {}) => {
      calls.push({ method, path, branchId: opts.branchId });
      return reply(path);
    },
  };
  const terminal = { current: () => ({ identity: { branchId } }) };
  const commands = {
    execute: jest.fn(async (_operation: string, body: { qty: number }) => ({
      result: { qty: body.qty, movementType: "adjustment_out" },
    })),
  };
  return {
    calls,
    commands,
    stock: new StockLookupService({
      api: api as unknown as ApiSession,
      terminal: terminal as unknown as TerminalService,
      commands: commands as unknown as SignedCommandService,
    }),
  };
}

describe("StockLookupService", () => {
  it("searches this branch's stocked range with the page's filter", async () => {
    const { stock, calls } = service(() => ({ items: [item()], total: 1, expiryWarningDays: 30 }));
    const found = await stock.search({ q: "augm", filter: "prescription", attention: "near_expiry" });
    expect(calls).toEqual([
      {
        method: "GET",
        path: "/inventory/stock-by-product?ledgerOnly=true&take=50&q=augm&prescription=true&attention=near_expiry",
        branchId,
      },
    ]);
    expect(found.items[0]).toMatchObject({
      name: "Augmentin 625mg Tablets",
      available: 8,
      onHand: 10,
      quarantined: 2,
      requiresPrescription: true,
      nextExpiry: "2027-01-31",
    });
  });

  it("counts Needs attention from the attention and low-stock filters", async () => {
    const { stock, calls } = service((path) => {
      if (path.includes("near_expiry"))
        return { items: [item(), item({ nearExpiryBatchCount: 2 })], total: 2, expiryWarningDays: 45 };
      if (path.includes("attention=quarantined"))
        return { items: [item({ quarantinedQty: 4 }), item({ quarantinedQty: 3 })], total: 2 };
      if (path.includes("status=low")) return { items: [], total: 9 };
      return { items: [], total: 0 };
    });
    expect(await stock.attention()).toEqual({
      expiringBatches: 3,
      expiredBatches: 0,
      quarantinedProducts: 2,
      quarantinedUnits: 7,
      lowStockProducts: 9,
      expiryWarningDays: 45,
    });
    expect(calls).toHaveLength(4);
    expect(calls.every((c) => c.method === "GET" && c.branchId === branchId)).toBe(true);
  });

  const rawProduct = () => ({
    product: { ...item().product, genericName: "Amoxicillin" },
    stockStatus: "ok",
    totals: { onHand: 10, available: 8, quarantined: 2, reserved: 0, expired: 0, incoming: 0 },
    batches: [
      {
        id: batchId,
        batchNo: "AUG-7520",
        expiryDate: "2027-02-28T00:00:00.000Z",
        daysToExpiry: 119,
        expired: false,
        nearExpiry: false,
        needsExpiryReview: false,
        isQuarantined: false,
        quarantineReason: null,
        qtyOnHand: 10,
        availableQty: 8,
        reservedQty: 0,
        quarantinedQty: 2,
        sellingPrice: "145.00",
        costPrice: null,
      },
    ],
    reservations: [],
    // An older server, or a password login, may still send quantities here: never passed on.
    otherBranches: [{ branchId: randomUUID(), name: "Galle", code: "GLE", available: 32, onHand: 40 }],
    recentMovements: [],
  });
  const kandy = randomUUID();
  const replyFor =
    (availability: () => unknown) =>
    (path: string): unknown => {
      if (path.endsWith("/policy")) return { threshold: "10000.00" };
      if (path.endsWith("/branch-availability")) return availability();
      return rawProduct();
    };

  it("reads one product's stock, the write-off limit and other branches as bands", async () => {
    const { stock, calls } = service(
      replyFor(() => ({
        productId,
        controlled: false,
        branches: [{ branchId: kandy, name: "Kandy", band: "low" }],
      })),
    );
    const view = await stock.product(productId);
    expect(calls.map((c) => c.path)).toEqual([
      `/inventory/products/${productId}/stock`,
      "/inventory/write-offs/policy",
      `/inventory/products/${productId}/branch-availability`,
    ]);
    expect(calls.every((c) => c.branchId === branchId)).toBe(true);
    expect(view.batches[0]).toMatchObject({ batchId, expiryDate: "2027-02-28", available: 8, costPrice: null });
    expect(view.writeOffLimit).toBe("10000.00");
    expect(view.otherBranches).toEqual({
      allowed: true,
      branches: [{ branchId: kandy, name: "Kandy", band: "low" }],
    });
    // The full detail's other branches (Galle, with quantities) are dropped, not merged in.
    expect(JSON.stringify(view.otherBranches)).not.toMatch(/Galle|available|onHand/);
  });

  it("shows no other branches when the role's permission is off", async () => {
    const { stock } = service(
      replyFor(() => {
        throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");
      }),
    );
    expect((await stock.product(productId)).otherBranches).toEqual({ allowed: false, branches: [] });
  });

  it("still fails on any other refusal", async () => {
    const { stock } = service(
      replyFor(() => {
        throw new ApiError(0, "NETWORK", "offline");
      }),
    );
    await expect(stock.product(productId)).rejects.toMatchObject({ code: "NETWORK" });
  });

  it("posts a write-off as the exact signed adjustment body", async () => {
    const { stock, commands } = service(() => null);
    await stock.adjust({ productId, batchId, kind: "expired", qty: 4, fromQuarantine: true });
    expect(commands.execute).toHaveBeenCalledWith(
      "POST /api/v1/inventory/adjustments",
      {
        kind: "expired",
        movementType: null,
        productId,
        batchId,
        newBatch: null,
        qty: 4,
        reason: null,
        fromQuarantine: true,
      },
      null,
    );
  });

  it("sends a correction's direction and reason, and never takes an increase from quarantine", async () => {
    const { stock, commands } = service(() => null);
    await stock.adjust({
      productId,
      batchId,
      kind: "correction",
      direction: "in",
      qty: 2,
      reason: "Miscounted",
      fromQuarantine: true,
    });
    expect(commands.execute.mock.calls[0]![1]).toMatchObject({
      kind: "correction",
      movementType: "adjustment_in",
      reason: "Miscounted",
      fromQuarantine: false,
    });
    await expect(
      stock.adjust({ productId, batchId, kind: "correction", direction: "out", qty: 1, fromQuarantine: false }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
