import { describe, expect, it } from "@jest/globals";
import type { OfflineModeState } from "../../shared/ipc-contract";
import {
  blockedText,
  cardAmount,
  cannotSellOffline,
  findOfflineLines,
  hoursBlock,
  sellingBanner,
  type OfflineStockLine,
} from "./offline-sell-model";

const line = (
  overrides: Partial<OfflineStockLine> & { name: string },
): OfflineStockLine => {
  const { name, ...rest } = overrides;
  return {
    snapshotLineId: `${name}-${rest.batchId ?? "b1"}`,
    productId: name,
    batchId: "b1",
    remaining: 10,
    unitPriceMinor: 9600,
    sellBefore: Date.UTC(2027, 7, 1),
    blocked: null,
    display: { name, strength: null, barcode: null, batchNo: "PN2409" },
    ...rest,
  };
};

const mode = (overrides: Partial<OfflineModeState> = {}): OfflineModeState => ({
  mode: "stopped",
  reason: null,
  clock: null,
  connected: false,
  outageStartedAt: null,
  grantExpiresAt: null,
  snapshotGeneratedAt: null,
  ...overrides,
});

describe("finding items in the saved stock", () => {
  const panadol = line({
    name: "Panadol 500mg Tablets",
    display: {
      name: "Panadol 500mg Tablets",
      strength: null,
      barcode: "4791111",
      batchNo: "PN2409",
    },
  });
  const extra = line({ name: "Panadol Extra", blocked: "STOCK_REVIEW" });
  const ors = line({ name: "Jeevanee ORS Sachet" });

  it("finds a scanned barcode exactly, and names by every word typed, sellable first", () => {
    expect(findOfflineLines([ors, panadol, extra], "4791111")).toEqual([
      panadol,
    ]);
    expect(findOfflineLines([extra, ors, panadol], "pana")).toEqual([
      panadol,
      extra,
    ]);
    expect(findOfflineLines([panadol, ors], "ors sachet")).toEqual([ors]);
    expect(findOfflineLines([panadol], "  ")).toEqual([]);
  });

  it("lists a product once per batch, soonest to expire first", () => {
    const later = line({
      name: "Link Samahan",
      batchId: "b2",
      sellBefore: Date.UTC(2028, 0, 1),
    });
    const sooner = line({
      name: "Link Samahan",
      batchId: "b1",
      sellBefore: Date.UTC(2027, 0, 1),
    });
    expect(findOfflineLines([later, sooner], "samahan")).toEqual([
      sooner,
      later,
    ]);
  });
});

describe("what the cashier is told", () => {
  it("says only that stock is under review, never why (Q3)", () => {
    expect(blockedText("STOCK_REVIEW")).toBe("Stock under review");
    expect(blockedText("NOT_ENOUGH_STOCK", 3)).toBe("Only 3 left (last-known)");
    expect(blockedText("NOT_ENOUGH_STOCK", 0)).toBe("None left (last-known)");
    expect(blockedText("NOT_SOLD_OFFLINE")).toBe("Needs an online check");
  });

  it("says how old the stock is and when offline selling ends, in the counter's days", () => {
    const now = new Date(2026, 10, 17, 16, 20);
    expect(
      sellingBanner(
        mode({
          mode: "offline",
          snapshotGeneratedAt: new Date(2026, 10, 17, 15, 41).toISOString(),
          outageStartedAt: new Date(2026, 10, 17, 15, 48).toISOString(),
          grantExpiresAt: new Date(2026, 10, 18, 8, 12).toISOString(),
        }),
        now,
      ),
    ).toBe(
      "Stock as of 15:41 today (7 min before this outage). Offline permission ends 08:12 tomorrow.",
    );
  });

  it("explains why a counter can't sell offline, and says nothing while it can", () => {
    expect(cannotSellOffline(null)).toBeNull();
    expect(cannotSellOffline(mode({ mode: "online" }))).toBeNull();
    expect(cannotSellOffline(mode({ mode: "offline" }))).toBeNull();
    expect(
      cannotSellOffline(mode({ reason: "NO_OFFLINE_AUTHORITY" }))?.text,
    ).toMatch(/isn't the branch's offline counter/);
    expect(
      cannotSellOffline(mode({ reason: "CLOCK_UNTRUSTED", clock: "NEW_BOOT" }))
        ?.text,
    ).toMatch(/restarted during the outage/);
    expect(cannotSellOffline(mode({ reason: "SYNC_PAUSED" }))?.text).toMatch(
      /manager must review/,
    );
    expect(cannotSellOffline(mode({ mode: "draining" }))?.title).toBe(
      "Finishing this counter's offline sales",
    );
  });

  it("stops sales outside selling hours until a manager acknowledges them (D8)", () => {
    expect(hoursBlock(null)).toBeNull();
    expect(hoursBlock({ status: "open" })).toBeNull();
    expect(
      hoursBlock({ status: "acknowledged", until: "x", managerName: "Dilani" }),
    ).toBeNull();
    expect(hoursBlock({ status: "needs_acknowledgement" })).toMatch(
      /manager must acknowledge/,
    );
    expect(hoursBlock({ status: "closed" })).toMatch(/closed/);
  });
});

describe("what goes on the card", () => {
  it("is the whole sale, the part typed for a split (capped at the total), or nothing", () => {
    expect(cardAmount("cash", 9600, "50")).toBe(0);
    expect(cardAmount("card", 9600, "")).toBe(9600);
    expect(cardAmount("split", 9600, "50")).toBe(5000);
    expect(cardAmount("split", 9600, "500")).toBe(9600);
    expect(cardAmount("split", 9600, "")).toBe(0);
  });
});
