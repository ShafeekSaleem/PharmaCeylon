import { randomUUID } from "node:crypto";
import type {
  CatalogProduct,
  CheckoutDraftView,
  CoSign,
  CompletedSale,
  Dispensing,
  HeldCart,
  Tender,
} from "../../shared/ipc-contract";
import { ApiError, type ApiSession } from "../api/api-client";
import type { PosDatabase } from "../db/database";
import type { Logger } from "../logging/logger";
import {
  ActionFailure,
  type TerminalService,
} from "../terminal/terminal-service";
import { fromMinor, toMinor } from "./money";

type RawCatalogProduct = {
  id: string;
  sku: string | null;
  name: string;
  barcode: string | null;
  strength: string | null;
  unit: string | null;
  isControlled: boolean;
  requiresPrescription: boolean;
  qtyOnHand: number;
  batches: { sellingPrice: string; qtyOnHand: number }[];
};

type RawSale = {
  id: string;
  invoiceNo: string;
  soldAt: string;
  subtotal: string;
  taxTotal: string;
  discountTotal: string;
  grandTotal: string;
  amountPaid: string;
  changeDue: string;
  items: {
    qty: number;
    unitPrice: string;
    lineTotal: string;
    product: { name: string };
  }[];
  payments: { method: string; amount: string; reference: string | null }[];
  seller: { fullName: string } | null;
};

type CheckoutRequest = {
  items: { productId: string; qty: number; unitPrice: string }[];
  payments: { method: "cash" | "card"; amount: string; reference?: string }[];
  customerId?: string;
  prescriptionId?: string;
};

/** What a recalled hold brings back: the lines plus the customer and prescription it was held with. */
export type RecalledHold = {
  lines: { productId: string; qty: number }[];
  customerId: string | null;
  prescriptionId: string | null;
};

type DraftRow = {
  id: string;
  work_session_id: string;
  staff_user_id: string;
  request_json: string;
  total_minor: number;
  status: "submitted" | "completed" | "uncertain" | "refused";
  sale_id: string | null;
  invoice_no: string | null;
  error_code: string | null;
  co_signer_id: string | null;
  created_at: string;
};

const toSale = (sale: RawSale): CompletedSale => ({
  saleId: sale.id,
  invoiceNo: sale.invoiceNo,
  soldAt: sale.soldAt,
  subtotal: sale.subtotal,
  taxTotal: sale.taxTotal,
  discountTotal: sale.discountTotal,
  grandTotal: sale.grandTotal,
  amountPaid: sale.amountPaid,
  changeDue: sale.changeDue,
  sellerName: sale.seller?.fullName ?? "",
  lines: sale.items.map((i) => ({
    name: i.product.name,
    qty: i.qty,
    unitPrice: i.unitPrice,
    lineTotal: i.lineTotal,
  })),
  payments: sale.payments.map((p) => ({
    method: p.method,
    amount: p.amount,
    reference: p.reference,
  })),
});

/**
 * Normal online checkout from the counter through the central sales API. Prices come from the
 * server's own catalog, never from the renderer, and the server reprices, taxes, picks FEFO
 * batches and deducts shared available stock exactly as for the web POS. Every reviewed checkout
 * is written down before it is sent; an uncertain outcome is resolved by resending the same
 * request under the same idempotency key, which returns the original sale.
 */
export class CheckoutService {
  private catalogCache: Map<string, CatalogProduct> = new Map();

  constructor(
    private readonly deps: {
      db: PosDatabase;
      api: ApiSession;
      terminal: TerminalService;
      logger: Logger;
      now?: () => Date;
    },
  ) {}

  private now() {
    return (this.deps.now ?? (() => new Date()))();
  }

  private counter() {
    const current = this.deps.terminal.current();
    if (!current)
      throw new ActionFailure(
        "NOT_SIGNED_IN",
        "Sign in at this counter first.",
      );
    return current;
  }

  async catalog(): Promise<CatalogProduct[]> {
    const { identity } = this.counter();
    const raw = await this.deps.api.request<
      RawCatalogProduct[] | { products: RawCatalogProduct[] }
    >("GET", "/sales/pos/catalog", { branchId: identity.branchId });
    const list = Array.isArray(raw) ? raw : raw.products;
    const products: CatalogProduct[] = list
      .filter((p) => p.batches.length > 0)
      .map((p) => ({
        productId: p.id,
        name: p.name,
        sku: p.sku,
        barcode: p.barcode,
        strength: p.strength,
        unit: p.unit,
        // FEFO: the batch the server will sell first sets the price, as on the web POS.
        unitPrice: p.batches[0]!.sellingPrice,
        available: p.qtyOnHand,
        needsPharmacist: p.isControlled || p.requiresPrescription,
        requiresPrescription: p.requiresPrescription,
        isControlled: p.isControlled,
      }));
    this.catalogCache = new Map(products.map((p) => [p.productId, p]));
    return products;
  }

  /** Builds the request from the cached server catalog; the renderer supplies only ids and quantities. */
  private buildRequest(
    lines: { productId: string; qty: number }[],
    tender: Tender,
    dispensing: Dispensing,
  ): { request: CheckoutRequest; totalMinor: number } {
    if (!lines.length)
      throw new ActionFailure("CART_EMPTY", "Add something to the sale first.");
    const items = lines.map((line) => {
      const product = this.catalogCache.get(line.productId);
      if (!product)
        throw new ActionFailure(
          "CATALOG_STALE",
          "The product list changed. Refresh it and try again.",
        );
      // The server enforces this too; asking here saves a refused sale at the till.
      if (product.needsPharmacist && !dispensing.prescriptionId)
        throw new ActionFailure(
          "PRESCRIPTION_REQUIRED",
          `${product.name} can only be sold against a prescription. Link one first.`,
        );
      if (line.qty > product.available)
        throw new ActionFailure(
          "NOT_ENOUGH_STOCK",
          `Only ${product.available} of ${product.name} available.`,
        );
      return {
        productId: product.productId,
        qty: line.qty,
        unitPrice: product.unitPrice,
      };
    });
    // Estimate before tax: the server adds VAT and returns the final total, which the receipt shows.
    const totalMinor = items.reduce(
      (sum, i) => sum + toMinor(i.unitPrice) * i.qty,
      0,
    );
    const payments: CheckoutRequest["payments"] = [];
    const cash = tender.cashAmount ? toMinor(tender.cashAmount) : 0;
    const card = tender.cardAmount ? toMinor(tender.cardAmount) : 0;
    if (card > 0) {
      if (!tender.cardReference?.trim())
        throw new ActionFailure(
          "CARD_REFERENCE_REQUIRED",
          "Enter the card terminal's approval reference.",
        );
      payments.push({
        method: "card",
        amount: fromMinor(card),
        reference: tender.cardReference.trim(),
      });
    }
    if (cash > 0) payments.push({ method: "cash", amount: fromMinor(cash) });
    return {
      request: {
        items,
        payments,
        ...(dispensing.customerId ? { customerId: dispensing.customerId } : {}),
        ...(dispensing.prescriptionId
          ? { prescriptionId: dispensing.prescriptionId }
          : {}),
      },
      totalMinor,
    };
  }

  /**
   * The co-signer's PIN goes to the server with this one request and is never written to the
   * draft: only who co-signed is kept, so an unconfirmed sale can ask the same person again.
   */
  async submit(
    lines: { productId: string; qty: number }[],
    tender: Tender,
    dispensing: Dispensing = {},
    coSign?: CoSign,
  ): Promise<CompletedSale> {
    const { staff, identity } = this.counter();
    const { request, totalMinor } = this.buildRequest(
      lines,
      tender,
      dispensing,
    );
    const id = randomUUID();
    const at = this.now().toISOString();
    this.deps.db
      .prepare(
        `INSERT INTO checkout_draft (id, work_session_id, staff_user_id, request_json, total_minor, status, co_signer_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'submitted', ?, ?, ?)`,
      )
      .run(
        id,
        staff.workSessionId,
        staff.staffUserId,
        JSON.stringify(request),
        totalMinor,
        coSign?.approverUserId ?? null,
        at,
        at,
      );
    return this.send(
      id,
      request,
      staff.workSessionId,
      identity.branchId,
      coSign,
    );
  }

  /** Parks the cart on the server so any counter at the branch can recall it. */
  async hold(
    lines: { productId: string; qty: number }[],
    label: string | undefined,
    dispensing: Dispensing = {},
  ): Promise<{ holdRef: string }> {
    const { identity } = this.counter();
    if (!lines.length)
      throw new ActionFailure("CART_EMPTY", "There is nothing to hold.");
    const totalMinor = lines.reduce((sum, line) => {
      const product = this.catalogCache.get(line.productId);
      if (!product)
        throw new ActionFailure(
          "CATALOG_STALE",
          "The product list changed. Refresh it and try again.",
        );
      return sum + toMinor(product.unitPrice) * line.qty;
    }, 0);
    const held = await this.deps.api.request<{ id: string; holdRef: string }>(
      "POST",
      "/sales/holds",
      {
        branchId: identity.branchId,
        body: {
          label: label?.trim() || undefined,
          itemCount: lines.reduce((sum, l) => sum + l.qty, 0),
          total: fromMinor(totalMinor),
          lines: lines.map((l) => ({ productId: l.productId, qty: l.qty })),
          // Same meta keys as the web POS, so a hold recalls with its customer and prescription anywhere.
          meta: {
            source: "desktop_counter",
            ...(dispensing.customerId
              ? { customerId: dispensing.customerId }
              : {}),
            ...(dispensing.prescriptionId
              ? { prescriptionId: dispensing.prescriptionId }
              : {}),
          },
        },
      },
    );
    return { holdRef: held.holdRef };
  }

  async holds(): Promise<HeldCart[]> {
    const { identity } = this.counter();
    const rows = await this.deps.api.request<
      {
        id: string;
        holdRef: string;
        label: string | null;
        itemCount: number;
        total: string;
        createdAt: string;
        heldByName: string;
      }[]
    >("GET", "/sales/holds", { branchId: identity.branchId });
    return rows.map((r) => ({
      holdId: r.id,
      holdRef: r.holdRef,
      label: r.label,
      itemCount: r.itemCount,
      total: r.total,
      createdAt: r.createdAt,
      heldBy: r.heldByName,
    }));
  }

  /** Recall claims the hold atomically on the server: two counters cannot both get it. */
  async recall(holdId: string): Promise<RecalledHold> {
    const { identity } = this.counter();
    const held = await this.deps.api.request<{
      payload: { lines?: unknown[]; meta?: Record<string, unknown> } | null;
    }>("POST", `/sales/holds/${holdId}/recall`, {
      branchId: identity.branchId,
    });
    const raw = Array.isArray(held.payload?.lines) ? held.payload!.lines : [];
    const meta = held.payload?.meta ?? {};
    const id = (value: unknown) =>
      typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value)
        ? value
        : null;
    return {
      lines: this.heldLines(raw),
      customerId: id(meta.customerId),
      prescriptionId: id(meta.prescriptionId),
    };
  }

  /** Accept only what this counter can sell from: product ids and whole quantities. */
  private heldLines(lines: unknown[]): { productId: string; qty: number }[] {
    return lines.flatMap((raw) => {
      const line = raw as { productId?: unknown; qty?: unknown };
      return typeof line.productId === "string" &&
        Number.isSafeInteger(line.qty) &&
        (line.qty as number) > 0
        ? [{ productId: line.productId, qty: line.qty as number }]
        : [];
    });
  }

  /**
   * Resends an uncertain checkout exactly as it was first sent. A sale the server already took
   * replays without the co-sign; one that never arrived needs the co-signer's PIN again.
   */
  async retry(draftId: string, coSign?: CoSign): Promise<CompletedSale> {
    const { staff, identity } = this.counter();
    const row = this.row(draftId);
    if (!row || (row.status !== "uncertain" && row.status !== "submitted"))
      throw new ActionFailure(
        "DRAFT_NOT_PENDING",
        "That sale is not waiting to be confirmed.",
      );
    // Only the person who rang it up resolves it; their idempotency scope is their own.
    if (row.staff_user_id !== staff.staffUserId)
      throw new ActionFailure(
        "DRAFT_OTHER_STAFF",
        "Only the person who rang this sale up can confirm it.",
      );
    if (coSign && coSign.approverUserId !== row.co_signer_id)
      throw new ActionFailure(
        "CO_SIGNER_CHANGED",
        "Only the pharmacist who co-signed this sale can confirm it.",
      );
    return this.send(
      row.id,
      JSON.parse(row.request_json) as CheckoutRequest,
      staff.workSessionId,
      identity.branchId,
      coSign,
    );
  }

  pending(): CheckoutDraftView[] {
    const rows = this.deps.db
      .prepare(
        "SELECT * FROM checkout_draft WHERE status IN ('submitted', 'uncertain') ORDER BY created_at",
      )
      .all() as DraftRow[];
    return rows.map((row) => ({
      draftId: row.id,
      staffUserId: row.staff_user_id,
      estimatedTotal: fromMinor(row.total_minor),
      createdAt: row.created_at,
      lineCount: (JSON.parse(row.request_json) as CheckoutRequest).items.length,
      coSignerId: row.co_signer_id,
    }));
  }

  private row(id: string): DraftRow | undefined {
    return this.deps.db
      .prepare("SELECT * FROM checkout_draft WHERE id = ?")
      .get(id) as DraftRow | undefined;
  }

  private mark(
    id: string,
    status: DraftRow["status"],
    fields: { saleId?: string; invoiceNo?: string; errorCode?: string },
  ) {
    this.deps.db
      .prepare(
        "UPDATE checkout_draft SET status = ?, sale_id = COALESCE(?, sale_id), invoice_no = COALESCE(?, invoice_no), error_code = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        status,
        fields.saleId ?? null,
        fields.invoiceNo ?? null,
        fields.errorCode ?? null,
        this.now().toISOString(),
        id,
      );
  }

  private async send(
    id: string,
    request: CheckoutRequest,
    workSessionId: string,
    branchId: string,
    coSign?: CoSign,
  ): Promise<CompletedSale> {
    try {
      const sale = await this.deps.api.request<RawSale>(
        "POST",
        "/sales/checkout",
        {
          branchId,
          body: coSign ? { ...request, pharmacistApproval: coSign } : request,
          headers: {
            "Idempotency-Key": id,
            "x-terminal-session": workSessionId,
          },
        },
      );
      this.mark(id, "completed", {
        saleId: sale.id,
        invoiceNo: sale.invoiceNo,
      });
      this.deps.logger.info("checkout.completed", {
        draftId: id,
        saleId: sale.id,
      });
      return toSale(sale);
    } catch (error) {
      if (error instanceof ApiError && error.uncertain) {
        this.mark(id, "uncertain", { errorCode: error.code });
        throw new ActionFailure(
          "CHECKOUT_UNCERTAIN",
          "The server did not answer. The sale may have gone through: confirm it before taking payment again.",
        );
      }
      this.mark(id, "refused", {
        errorCode: error instanceof ApiError ? error.code : "UNEXPECTED",
      });
      throw error;
    }
  }
}
