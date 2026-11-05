import type { SignedOperationBody } from "@pharmaceylon/shared";
import type {
  ProductStock,
  StockAdjustment,
  StockAttention,
  StockAttentionKind,
  StockFilter,
  StockRow,
  StockSearch,
} from "../../shared/ipc-contract";
import { ApiError, type ApiSession } from "../api/api-client";
import { ActionFailure, type TerminalService } from "./terminal-service";
import type { SignedCommandService } from "./signed-commands";

type RawStockItem = {
  productId: string;
  qtyOnHand: number;
  availableQty: number;
  quarantinedQty: number;
  reservedQty: number;
  stockStatus: "ok" | "low" | "out";
  batchCount: number;
  nearExpiryBatchCount: number;
  expiredBatchCount: number;
  nextExpiry?: string | null;
  product: {
    id: string;
    name: string;
    strength: string | null;
    unit: string | null;
    manufacturer?: string | null;
    unitsPerPack?: number;
    packLabel?: string | null;
    requiresPrescription?: boolean;
    isControlled: boolean;
    reorderLevel: number;
  };
};

type RawStockList = {
  items: RawStockItem[];
  total: number;
  expiryWarningDays?: number;
};

type RawBranchAvailability = {
  productId: string;
  controlled: boolean;
  branches: {
    branchId: string;
    name: string;
    band: "in_stock" | "low" | "out" | "ask_pharmacist";
  }[];
};

type RawProductStock = {
  product: {
    id: string;
    name: string;
    genericName: string | null;
    strength: string | null;
    manufacturer?: string | null;
    unit: string | null;
    unitsPerPack?: number;
    packLabel?: string | null;
    requiresPrescription?: boolean;
    isControlled: boolean;
    reorderLevel: number;
  };
  stockStatus: "ok" | "low" | "out";
  totals: {
    onHand: number;
    available: number;
    quarantined: number;
    reserved: number;
    expired: number;
  };
  batches: {
    id: string;
    batchNo: string;
    expiryDate: string;
    daysToExpiry: number;
    expired: boolean;
    nearExpiry: boolean;
    needsExpiryReview: boolean;
    isQuarantined: boolean;
    quarantineReason: string | null;
    qtyOnHand: number;
    availableQty: number;
    reservedQty: number;
    quarantinedQty: number;
    sellingPrice: string;
    costPrice: string | null;
  }[];
  reservations: { qty: number; label: string }[];
  recentMovements: {
    id: string;
    occurredAt: string;
    movementType: string;
    batchNo: string | null;
    qtyDelta: number;
    quarantineDelta: number;
    actorName: string | null;
  }[];
};

/** Enough rows to count a branch's attention lists; the lookup itself shows far fewer. */
const ATTENTION_TAKE = 200;
const SEARCH_TAKE = 50;
const DEFAULT_EXPIRY_WINDOW_DAYS = 30;

const toRow = (item: RawStockItem): StockRow => ({
  productId: item.productId,
  name: item.product.name,
  strength: item.product.strength,
  unit: item.product.unit,
  manufacturer: item.product.manufacturer ?? null,
  unitsPerPack: item.product.unitsPerPack ?? 1,
  packLabel: item.product.packLabel ?? null,
  requiresPrescription: item.product.requiresPrescription ?? false,
  isControlled: item.product.isControlled,
  reorderLevel: item.product.reorderLevel,
  stockStatus: item.stockStatus,
  available: item.availableQty,
  onHand: item.qtyOnHand,
  quarantined: item.quarantinedQty,
  reserved: item.reservedQty,
  batchCount: item.batchCount,
  nearExpiryBatchCount: item.nearExpiryBatchCount,
  expiredBatchCount: item.expiredBatchCount,
  nextExpiry: item.nextExpiry ?? null,
});

/**
 * The Stock page's reads (`inventory/stock-by-product`, `inventory/products/:productId/stock`,
 * `inventory/write-offs/policy`, all counter routes) and its one write, a direct adjustment,
 * which goes through the signed command like every other physical change at the counter.
 */
export class StockLookupService {
  constructor(
    private readonly deps: {
      api: ApiSession;
      terminal: TerminalService;
      commands: SignedCommandService;
    },
  ) {}

  private branchId() {
    const current = this.deps.terminal.current();
    if (!current)
      throw new ActionFailure(
        "NOT_SIGNED_IN",
        "Sign in at this counter first.",
      );
    return current.identity.branchId;
  }

  private list(params: Record<string, string>) {
    const query = new URLSearchParams({ ledgerOnly: "true", ...params });
    return this.deps.api.request<RawStockList>(
      "GET",
      `/inventory/stock-by-product?${query.toString()}`,
      { branchId: this.branchId() },
    );
  }

  async search(input: {
    q?: string;
    filter: StockFilter;
    attention?: StockAttentionKind;
  }): Promise<StockSearch> {
    const params: Record<string, string> = { take: String(SEARCH_TAKE) };
    if (input.q) params.q = input.q;
    if (input.filter === "low") params.status = "low";
    if (input.filter === "prescription") params.prescription = "true";
    if (input.filter === "controlled") params.controlled = "controlled";
    if (input.attention) params.attention = input.attention;
    const raw = await this.list(params);
    return {
      items: raw.items.map(toRow),
      total: raw.total,
      expiryWarningDays: raw.expiryWarningDays ?? DEFAULT_EXPIRY_WINDOW_DAYS,
    };
  }

  /** The Needs attention counts for this branch, from the same filters the lists use. */
  async attention(): Promise<StockAttention> {
    const take = String(ATTENTION_TAKE);
    const [expiring, expired, quarantined, low] = await Promise.all([
      this.list({ attention: "near_expiry", take }),
      this.list({ attention: "expired", take }),
      this.list({ attention: "quarantined", take }),
      this.list({ status: "low", take }),
    ]);
    return {
      expiringBatches: expiring.items.reduce(
        (sum, i) => sum + i.nearExpiryBatchCount,
        0,
      ),
      expiredBatches: expired.items.reduce(
        (sum, i) => sum + i.expiredBatchCount,
        0,
      ),
      quarantinedProducts: quarantined.total,
      quarantinedUnits: quarantined.items.reduce(
        (sum, i) => sum + i.quarantinedQty,
        0,
      ),
      lowStockProducts: low.total,
      expiryWarningDays:
        expiring.expiryWarningDays ?? DEFAULT_EXPIRY_WINDOW_DAYS,
    };
  }

  async product(productId: string): Promise<ProductStock> {
    const branchId = this.branchId();
    const path = `/inventory/products/${encodeURIComponent(productId)}`;
    const [raw, policy, availability] = await Promise.all([
      this.deps.api.request<RawProductStock>("GET", `${path}/stock`, {
        branchId,
      }),
      this.deps.api.request<{ threshold: string | null }>(
        "GET",
        "/inventory/write-offs/policy",
        { branchId },
      ),
      // Refused (403) when the role has inventory.view_other_branches_availability switched off:
      // the page then says so instead of failing.
      this.deps.api
        .request<RawBranchAvailability>("GET", `${path}/branch-availability`, {
          branchId,
        })
        .catch((error: unknown) => {
          if (error instanceof ApiError && error.status === 403) return null;
          throw error;
        }),
    ]);
    return {
      product: {
        productId: raw.product.id,
        name: raw.product.name,
        genericName: raw.product.genericName,
        strength: raw.product.strength,
        manufacturer: raw.product.manufacturer ?? null,
        unit: raw.product.unit,
        unitsPerPack: raw.product.unitsPerPack ?? 1,
        packLabel: raw.product.packLabel ?? null,
        requiresPrescription: raw.product.requiresPrescription ?? false,
        isControlled: raw.product.isControlled,
        reorderLevel: raw.product.reorderLevel,
      },
      stockStatus: raw.stockStatus,
      totals: {
        onHand: raw.totals.onHand,
        available: raw.totals.available,
        quarantined: raw.totals.quarantined,
        reserved: raw.totals.reserved,
        expired: raw.totals.expired,
      },
      batches: raw.batches.map((b) => ({
        batchId: b.id,
        batchNo: b.batchNo,
        expiryDate: b.expiryDate.slice(0, 10),
        daysToExpiry: b.daysToExpiry,
        expired: b.expired,
        nearExpiry: b.nearExpiry,
        needsExpiryReview: b.needsExpiryReview,
        isQuarantined: b.isQuarantined,
        quarantineReason: b.quarantineReason,
        onHand: b.qtyOnHand,
        available: b.availableQty,
        reserved: b.reservedQty,
        quarantined: b.quarantinedQty,
        sellingPrice: b.sellingPrice,
        costPrice: b.costPrice,
      })),
      reservations: raw.reservations.map((r) => ({
        qty: r.qty,
        label: r.label,
      })),
      // Bands only, from their own read; nothing about other branches comes from the full detail.
      otherBranches: availability
        ? {
            allowed: true,
            branches: availability.branches.map((b) => ({
              branchId: b.branchId,
              name: b.name,
              band: b.band,
            })),
          }
        : { allowed: false, branches: [] },
      movements: raw.recentMovements.map((m) => ({
        id: m.id,
        occurredAt: m.occurredAt,
        movementType: m.movementType,
        batchNo: m.batchNo,
        qtyDelta: m.qtyDelta,
        quarantineDelta: m.quarantineDelta,
        actorName: m.actorName,
      })),
      writeOffLimit: policy.threshold,
    };
  }

  /**
   * A direct adjustment at the counter, signed. The server checks the person's permission
   * (`inventory.manage` to add, `inventory.write_off` to remove) and the write-off limit; a
   * write-off that needs a manager is refused (WRITE_OFF_APPROVAL_REQUIRED) and nothing moves.
   */
  async adjust(input: StockAdjustment) {
    const correction = input.kind === "correction";
    if (correction && !input.direction)
      throw new ActionFailure(
        "INVALID_INPUT",
        "Say whether the correction adds or removes stock.",
      );
    if (correction && !input.reason)
      throw new ActionFailure("INVALID_INPUT", "Give a reason for the correction.");
    const increase = correction
      ? input.direction === "in"
      : input.kind === "found";
    const body: SignedOperationBody["POST /api/v1/inventory/adjustments"] = {
      kind: input.kind,
      movementType: correction
        ? input.direction === "in"
          ? "adjustment_in"
          : "adjustment_out"
        : null,
      productId: input.productId,
      batchId: input.batchId,
      newBatch: null,
      qty: input.qty,
      reason: input.reason ? input.reason : null,
      fromQuarantine: increase ? false : input.fromQuarantine,
    };
    const receipt = await this.deps.commands.execute(
      "POST /api/v1/inventory/adjustments",
      body,
      null,
    );
    return { qty: receipt.result.qty, movementType: receipt.result.movementType };
  }
}
