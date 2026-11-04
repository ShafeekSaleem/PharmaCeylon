import { randomUUID } from "node:crypto";
import type {
  CatalogView,
  CatalogProduct,
  CheckoutDraftView,
  CoSign,
  CompletedSale,
  Dispensing,
  ApproverView,
  HeldCart,
  SaleLine,
  Tender,
} from "../../shared/ipc-contract";
import { ApiError, type ApiSession } from "../api/api-client";
import { isDefiniteRefusal } from "../api/definite-refusal";
import type { PosDatabase } from "../db/database";
import type { Logger } from "../logging/logger";
import {
  ActionFailure,
  type TerminalService,
} from "../terminal/terminal-service";
import { saleTotalMinor } from "../../shared/sale-total";
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
    discountAmount?: string;
    lineTotal: string;
    product: { name: string };
  }[];
  payments: { method: string; amount: string; reference: string | null }[];
  seller: { fullName: string } | null;
  discountApprover?: { fullName: string } | null;
};

type CheckoutRequest = {
  items: { productId: string; qty: number; unitPrice: string; discountAmount?: string }[];
  payments: { method: "cash" | "card"; amount: string; reference?: string }[];
  customerId?: string;
  prescriptionId?: string;
};

/** What a recalled hold brings back: the lines plus the customer and prescription it was held with. */
export type RecalledHold = {
  lines: { productId: string; qty: number; discountMinor: number }[];
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
  discount_co_signer_id: string | null;
  branch_id: string | null;
  enrollment_id: string | null;
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
  discountApproverName: sale.discountApprover?.fullName ?? null,
  lines: sale.items.map((i) => ({
    name: i.product.name,
    qty: i.qty,
    unitPrice: i.unitPrice,
    discountAmount: i.discountAmount ?? "0.00",
    lineTotal: i.lineTotal,
  })),
  payments: sale.payments.map((p) => ({
    method: p.method,
    amount: p.amount,
    reference: p.reference,
  })),
});

/**
 * The manager's discount co-sign and the pharmacist's both refuse a wrong PIN with the same codes;
 * the server says which it was (`coSign: "discount"`), and the counter reopens the right sheet.
 */
function discountCoSignRefusal(error: unknown): unknown {
  if (error instanceof ApiError && error.body.coSign === "discount")
    return new ActionFailure("DISCOUNT_COSIGN_REFUSED", error.message);
  return error;
}

/**
 * Normal online checkout from the counter through the central sales API. Prices come from the
 * server's own catalog, never from the renderer, and the server reprices, taxes, picks FEFO
 * batches and deducts shared available stock exactly as for the web POS. Every reviewed checkout
 * is written down before it is sent; an uncertain outcome is resolved by resending the same
 * request under the same idempotency key, which returns the original sale.
 */
export class CheckoutService {
  private catalogCache: Map<string, CatalogProduct> = new Map();
  private vatRatePercent = 0;

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

  async catalog(): Promise<CatalogView> {
    const { identity } = this.counter();
    const raw = await this.deps.api.request<{
      products: RawCatalogProduct[];
      vatRatePercent?: number;
      maxDiscountPercent?: number;
    }>("GET", "/sales/pos/catalog", { branchId: identity.branchId });
    const list = raw.products;
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
    this.vatRatePercent =
      typeof raw.vatRatePercent === "number" && raw.vatRatePercent > 0
        ? raw.vatRatePercent
        : 0;
    // An older server doesn't send the limit: show its default, which it enforces anyway.
    const maxDiscountPercent =
      typeof raw.maxDiscountPercent === "number" && raw.maxDiscountPercent >= 0 && raw.maxDiscountPercent <= 100
        ? raw.maxDiscountPercent
        : 10;
    return { products, vatRatePercent: this.vatRatePercent, maxDiscountPercent };
  }

  /** Builds the request from the cached server catalog; the renderer supplies only ids and quantities. */
  private buildRequest(
    lines: SaleLine[],
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
      // A line discount is an amount off the line, never more than the line (the server refuses
      // that too). Whether it needs a manager is the server's call, against the limit it reads.
      const discountMinor = line.discountMinor ?? 0;
      if (discountMinor > toMinor(product.unitPrice) * line.qty)
        throw new ActionFailure(
          "DISCOUNT_TOO_LARGE",
          `The discount on ${product.name} is more than the line.`,
        );
      return {
        productId: product.productId,
        qty: line.qty,
        unitPrice: product.unitPrice,
        ...(discountMinor > 0 ? { discountAmount: fromMinor(discountMinor) } : {}),
      };
    });
    // The total the cashier reviewed, VAT included, as the server will compute it.
    const { totalMinor } = saleTotalMinor(
      items.map((i) => ({
        unitPriceMinor: toMinor(i.unitPrice),
        qty: i.qty,
        discountMinor: i.discountAmount ? toMinor(i.discountAmount) : 0,
      })),
      this.vatRatePercent,
    );
    const payments: CheckoutRequest["payments"] = [];
    const cash = tender.cashAmount ? toMinor(tender.cashAmount) : 0;
    const card = tender.cardAmount ? toMinor(tender.cardAmount) : 0;
    // An empty tender would be booked by the server as exact cash nobody counted.
    if (cash + card <= 0)
      throw new ActionFailure(
        "TENDER_REQUIRED",
        `Enter what the customer paid. The total is ${fromMinor(totalMinor)}.`,
      );
    if (cash + card < totalMinor)
      throw new ActionFailure(
        "TENDER_SHORT",
        `The customer has paid ${fromMinor(cash + card)} of ${fromMinor(totalMinor)}.`,
      );
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
   * The co-signers' PINs go to the server with this one request and are never written to the
   * draft: only who co-signed is kept, so an unconfirmed sale can ask the same people again.
   * `coSign` is a pharmacist's for controlled items; `discountCoSign` a manager's for a discount
   * over the limit (P2b #103). Both need the server, so neither works offline.
   */
  async submit(
    lines: SaleLine[],
    tender: Tender,
    dispensing: Dispensing = {},
    coSign?: CoSign,
    discountCoSign?: CoSign,
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
        `INSERT INTO checkout_draft (id, work_session_id, staff_user_id, request_json, total_minor, status, co_signer_id, discount_co_signer_id, branch_id, enrollment_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'submitted', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        staff.workSessionId,
        staff.staffUserId,
        JSON.stringify(request),
        totalMinor,
        coSign?.approverUserId ?? null,
        discountCoSign?.approverUserId ?? null,
        identity.branchId,
        identity.enrollmentId,
        at,
        at,
      );
    return this.send(
      id,
      request,
      staff.workSessionId,
      identity.branchId,
      { coSign, discountCoSign },
      false,
    );
  }

  /**
   * Who can co-sign a discount over the limit here (`sales.discount_override`), leaving out the
   * person signed in: approving their own discount is their own authority, not a co-sign.
   */
  async discountApprovers(): Promise<ApproverView[]> {
    const { identity, staff } = this.counter();
    const rows = await this.deps.api.request<{ id: string; fullName: string; hasPosPin: boolean }[]>(
      "GET",
      "/sales/pos/discount-approvers",
      { branchId: identity.branchId },
    );
    return rows
      .filter((r) => r.id !== staff.staffUserId)
      .map((r) => ({ userId: r.id, fullName: r.fullName, hasPin: r.hasPosPin }));
  }

  /** Parks the cart on the server so any counter at the branch can recall it. */
  async hold(
    lines: SaleLine[],
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
      return sum + toMinor(product.unitPrice) * line.qty - (line.discountMinor ?? 0);
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
          // A discount travels with its line; a manager's co-sign never does, so a held discount
          // over the limit is approved again when the sale is completed.
          lines: lines.map((l) => ({
            productId: l.productId,
            qty: l.qty,
            ...(l.discountMinor ? { discountAmount: fromMinor(l.discountMinor) } : {}),
          })),
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
  private heldLines(lines: unknown[]): RecalledHold["lines"] {
    return lines.flatMap((raw) => {
      const line = raw as { productId?: unknown; qty?: unknown; discountAmount?: unknown };
      const discount =
        typeof line.discountAmount === "string" && /^\d{1,9}(\.\d{1,2})?$/.test(line.discountAmount)
          ? toMinor(line.discountAmount)
          : 0;
      return typeof line.productId === "string" &&
        Number.isSafeInteger(line.qty) &&
        (line.qty as number) > 0
        ? [{ productId: line.productId, qty: line.qty as number, discountMinor: discount }]
        : [];
    });
  }

  /**
   * Resends an uncertain checkout exactly as it was first sent. A sale the server already took
   * replays without the co-sign; one that never arrived needs the co-signer's PIN again.
   */
  async retry(draftId: string, coSign?: CoSign, discountCoSign?: CoSign): Promise<CompletedSale> {
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
    // The sale belongs to the branch and enrollment it was rung up on. Resending it from a counter
    // re-enrolled elsewhere would post it, and take the stock, at the wrong branch.
    if (
      (row.branch_id && row.branch_id !== identity.branchId) ||
      (row.enrollment_id && row.enrollment_id !== identity.enrollmentId)
    )
      throw new ActionFailure(
        "DRAFT_OTHER_COUNTER",
        "This sale was rung up before the counter was re-enrolled. Check it in Sales history on the web.",
      );
    if (coSign && coSign.approverUserId !== row.co_signer_id)
      throw new ActionFailure(
        "CO_SIGNER_CHANGED",
        "Only the pharmacist who co-signed this sale can confirm it.",
      );
    if (discountCoSign && discountCoSign.approverUserId !== row.discount_co_signer_id)
      throw new ActionFailure(
        "CO_SIGNER_CHANGED",
        "Only the manager who approved this sale's discount can confirm it.",
      );
    return this.send(
      row.id,
      JSON.parse(row.request_json) as CheckoutRequest,
      staff.workSessionId,
      identity.branchId,
      { coSign, discountCoSign },
      true,
    );
  }

  /**
   * Sales sent without a definite answer. The server scopes idempotency to the seller, so only the
   * person who rang one up can confirm it; their name is shown so the counter knows who to call back.
   */
  pending(): CheckoutDraftView[] {
    const rows = this.deps.db
      .prepare(
        `SELECT d.*, (SELECT staff_name FROM staff_session_log l WHERE l.work_session_id = d.work_session_id) AS staff_name
         FROM checkout_draft d WHERE d.status IN ('submitted', 'uncertain') ORDER BY d.created_at`,
      )
      .all() as (DraftRow & { staff_name: string | null })[];
    return rows.map((row) => ({
      draftId: row.id,
      staffUserId: row.staff_user_id,
      estimatedTotal: fromMinor(row.total_minor),
      createdAt: row.created_at,
      lineCount: (JSON.parse(row.request_json) as CheckoutRequest).items.length,
      coSignerId: row.co_signer_id,
      discountCoSignerId: row.discount_co_signer_id,
      staffName: row.staff_name,
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
    { coSign, discountCoSign }: { coSign?: CoSign; discountCoSign?: CoSign },
    resend: boolean,
  ): Promise<CompletedSale> {
    try {
      const sale = await this.deps.api.request<RawSale>(
        "POST",
        "/sales/checkout",
        {
          branchId,
          body: {
            ...request,
            ...(coSign ? { pharmacistApproval: coSign } : {}),
            ...(discountCoSign ? { discountApproval: discountCoSign } : {}),
          },
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
      const errorCode = error instanceof ApiError ? error.code : "UNEXPECTED";
      if (!isDefiniteRefusal(error, resend)) {
        // Refused before the server could find the first attempt (sign-in, permission, the
        // co-sign PIN): the original may still have landed, so it stays pending.
        this.mark(id, "uncertain", { errorCode });
        throw discountCoSignRefusal(error);
      }
      this.mark(id, "refused", { errorCode });
      throw discountCoSignRefusal(error);
    } finally {
      // Nothing to clean: the PINs live only in this call's arguments.
    }
  }
}
