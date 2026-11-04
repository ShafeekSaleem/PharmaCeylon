import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, type ApiSession } from "../api/api-client";
import type { SecretProtector } from "../db/key-store";
import { migrations } from "../db/migrations";
import { openLocalStore, type LocalStore } from "../local-store";
import type { Logger } from "../logging/logger";
import type { TerminalService } from "../terminal/terminal-service";
import { CheckoutService } from "./checkout-service";
import { fromMinor, toMinor } from "./money";

const protector: SecretProtector = {
  isAvailable: () => true,
  protect: (plain) => Buffer.from(plain, "utf8"),
  unprotect: (blob) => blob.toString("utf8"),
};
const logger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  flush: async () => {},
};
const branchId = randomUUID();
const staffUserId = randomUUID();
const workSessionId = randomUUID();
const paracetamol = randomUUID();
const morphine = randomUUID();
const prescriptionId = randomUUID();
const customerId = randomUUID();
const pharmacistId = randomUUID();
let identity = {
  tenantId: randomUUID(),
  branchId,
  terminalId: randomUUID(),
  enrollmentId: randomUUID(),
  keyId: "k",
};

const catalogResponse = {
  products: [
    {
      id: paracetamol,
      sku: "P500",
      name: "Paracetamol",
      barcode: "4790001",
      strength: "500mg",
      unit: "tab",
      isControlled: false,
      requiresPrescription: false,
      qtyOnHand: 10,
      batches: [{ sellingPrice: "2.50", qtyOnHand: 10 }],
    },
    {
      id: morphine,
      sku: "M10",
      name: "Morphine",
      barcode: null,
      strength: null,
      unit: null,
      isControlled: true,
      requiresPrescription: true,
      qtyOnHand: 5,
      batches: [{ sellingPrice: "40.00", qtyOnHand: 5 }],
    },
  ],
  departments: [],
  vatRatePercent: 0,
};
const saleResponse = (id = randomUUID()) => ({
  id,
  invoiceNo: "INV-0042",
  soldAt: new Date().toISOString(),
  subtotal: "5.00",
  taxTotal: "0.00",
  discountTotal: "0.00",
  grandTotal: "5.00",
  amountPaid: "10.00",
  changeDue: "5.00",
  items: [
    {
      qty: 2,
      unitPrice: "2.50",
      lineTotal: "5.00",
      product: { name: "Paracetamol" },
    },
  ],
  payments: [{ method: "cash", amount: "10.00", reference: null }],
  seller: { fullName: "Cashier" },
});

let dir: string;
let local: LocalStore;
let calls: {
  path: string;
  opts: { body?: unknown; headers?: Record<string, string> };
}[];
let checkoutReply: () => unknown;
let recallLines: unknown[] | undefined;
const managerId = randomUUID();

function service() {
  const api = {
    request: async (
      _method: string,
      path: string,
      opts: { body?: unknown; headers?: Record<string, string> } = {},
    ) => {
      calls.push({ path, opts });
      if (path === "/sales/pos/catalog") return catalogResponse;
      if (path === "/sales/holds" && opts.body)
        return { id: randomUUID(), holdRef: "HOLD-0007" };
      if (path === "/sales/pos/discount-approvers")
        return [
          { id: managerId, fullName: "Nimal Manager", hasPosPin: true },
          { id: staffUserId, fullName: "Cashier", hasPosPin: true },
        ];
      if (path.endsWith("/recall"))
        return {
          payload: {
            lines: recallLines ?? [
              { productId: paracetamol, qty: 2 },
              { productId: "x", qty: "3" },
              { name: "web-only" },
            ],
            meta: { customerId, prescriptionId: "not-an-id" },
          },
        };
      if (path === "/sales/checkout") {
        // The draft must already be on disk when the request leaves.
        const row = local.db
          .prepare("SELECT status FROM checkout_draft WHERE id = ?")
          .get(opts.headers?.["Idempotency-Key"]);
        expect(row).toEqual({
          status: expect.stringMatching(/submitted|uncertain/),
        });
        return checkoutReply();
      }
      throw new Error(path);
    },
  };
  const terminal = {
    current: () => ({
      staff: { workSessionId, staffUserId, staffName: "Cashier", openedAt: "" },
      identity,
    }),
  };
  return new CheckoutService({
    db: local.db,
    api: api as unknown as ApiSession,
    terminal: terminal as unknown as TerminalService,
    logger,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pos-checkout-spec-"));
  local = openLocalStore(dir, protector, migrations);
  calls = [];
  checkoutReply = () => saleResponse();
  recallLines = undefined;
  catalogResponse.vatRatePercent = 0;
  identity = { ...identity, branchId, enrollmentId: randomUUID() };
});
afterEach(() => {
  local.db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("money", () => {
  it("round-trips two-decimal amounts through minor units", () => {
    expect(toMinor("2.5")).toBe(250);
    expect(toMinor("1000.05")).toBe(100005);
    expect(fromMinor(250)).toBe("2.50");
    expect(fromMinor(-5)).toBe("-0.05");
    expect(() => toMinor("1.234")).toThrow();
  });
});

describe("CheckoutService", () => {
  it("sends server catalog prices with the idempotency key and counter session", async () => {
    const checkout = service();
    await checkout.catalog();
    const sale = await checkout.submit([{ productId: paracetamol, qty: 2 }], {
      cashAmount: "10",
    });
    expect(sale).toMatchObject({ invoiceNo: "INV-0042", changeDue: "5.00" });
    const sent = calls.find((c) => c.path === "/sales/checkout")!;
    expect(sent.opts.body).toEqual({
      items: [{ productId: paracetamol, qty: 2, unitPrice: "2.50" }],
      payments: [{ method: "cash", amount: "10.00" }],
    });
    expect(sent.opts.headers).toMatchObject({
      "x-terminal-session": workSessionId,
    });
    expect(
      local.db.prepare("SELECT status, sale_id FROM checkout_draft").get(),
    ).toEqual({ status: "completed", sale_id: sale.saleId });
  });

  it("keeps an uncertain checkout and resends it identically, so the server can replay the original sale", async () => {
    const checkout = service();
    await checkout.catalog();
    checkoutReply = () => {
      throw new ApiError(0, "NETWORK", "lost");
    };
    await expect(
      checkout.submit([{ productId: paracetamol, qty: 1 }], {
        cardAmount: "2.50",
        cardReference: "A1",
      }),
    ).rejects.toMatchObject({
      code: "CHECKOUT_UNCERTAIN",
    });
    const [pending] = checkout.pending();
    expect(pending).toMatchObject({ estimatedTotal: "2.50", lineCount: 1 });

    const original = randomUUID();
    checkoutReply = () => saleResponse(original);
    const resolved = await checkout.retry(pending!.draftId);
    expect(resolved.saleId).toBe(original);
    const [first, second] = calls.filter((c) => c.path === "/sales/checkout");
    expect(second!.opts.body).toEqual(first!.opts.body);
    expect(second!.opts.headers!["Idempotency-Key"]).toBe(
      first!.opts.headers!["Idempotency-Key"],
    );
    expect(checkout.pending()).toEqual([]);
  });

  it("records a definite refusal and does not offer it for retry", async () => {
    const checkout = service();
    await checkout.catalog();
    checkoutReply = () => {
      throw new ApiError(400, "INSUFFICIENT_STOCK", "Not enough stock");
    };
    await expect(
      checkout.submit([{ productId: paracetamol, qty: 1 }], { cashAmount: "5" }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(checkout.pending()).toEqual([]);
    expect(
      local.db.prepare("SELECT status, error_code FROM checkout_draft").get(),
    ).toEqual({
      status: "refused",
      error_code: "INSUFFICIENT_STOCK",
    });
  });

  it("refuses prescription items without a prescription, unknown products, overselling and a card without its reference", async () => {
    const checkout = service();
    await checkout.catalog();
    await expect(
      checkout.submit([{ productId: morphine, qty: 1 }], {}),
    ).rejects.toMatchObject({ code: "PRESCRIPTION_REQUIRED" });
    await expect(
      checkout.submit([{ productId: randomUUID(), qty: 1 }], {}),
    ).rejects.toMatchObject({ code: "CATALOG_STALE" });
    await expect(
      checkout.submit([{ productId: paracetamol, qty: 11 }], {}),
    ).rejects.toMatchObject({ code: "NOT_ENOUGH_STOCK" });
    await expect(
      checkout.submit([{ productId: paracetamol, qty: 1 }], {
        cardAmount: "2.50",
      }),
    ).rejects.toMatchObject({
      code: "CARD_REFERENCE_REQUIRED",
    });
    expect(calls.some((c) => c.path === "/sales/checkout")).toBe(false);
  });

  it("sends the prescription and co-sign, keeping who co-signed but never the PIN", async () => {
    const checkout = service();
    await checkout.catalog();
    await checkout.submit(
      [{ productId: morphine, qty: 1 }],
      { cashAmount: "40" },
      { customerId, prescriptionId },
      { approverUserId: pharmacistId, pin: "4321" },
    );
    const sent = calls.find((c) => c.path === "/sales/checkout")!;
    expect(sent.opts.body).toMatchObject({
      customerId,
      prescriptionId,
      pharmacistApproval: { approverUserId: pharmacistId, pin: "4321" },
    });
    const row = local.db
      .prepare("SELECT request_json, co_signer_id FROM checkout_draft")
      .get() as { request_json: string; co_signer_id: string };
    expect(row.co_signer_id).toBe(pharmacistId);
    expect(row.request_json).not.toContain("4321");
    expect(JSON.parse(row.request_json)).not.toHaveProperty(
      "pharmacistApproval",
    );
  });

  it("confirms an unanswered co-signed sale with the same pharmacist's PIN only", async () => {
    const checkout = service();
    await checkout.catalog();
    checkoutReply = () => {
      throw new ApiError(0, "NETWORK", "lost");
    };
    await expect(
      checkout.submit(
        [{ productId: morphine, qty: 1 }],
        { cashAmount: "40" },
        { prescriptionId },
        { approverUserId: pharmacistId, pin: "4321" },
      ),
    ).rejects.toMatchObject({ code: "CHECKOUT_UNCERTAIN" });
    const [pending] = checkout.pending();
    expect(pending!.coSignerId).toBe(pharmacistId);
    await expect(
      checkout.retry(pending!.draftId, {
        approverUserId: randomUUID(),
        pin: "1111",
      }),
    ).rejects.toMatchObject({ code: "CO_SIGNER_CHANGED" });
    checkoutReply = () => saleResponse();
    await checkout.retry(pending!.draftId, {
      approverUserId: pharmacistId,
      pin: "4321",
    });
    const [first, second] = calls.filter((c) => c.path === "/sales/checkout");
    expect(second!.opts.body).toEqual(first!.opts.body);
  });

  it("clears an unanswered co-signed sale once its co-signer's SLMC registration is refused", async () => {
    const checkout = service();
    await checkout.catalog();
    checkoutReply = () => {
      throw new ApiError(0, "NETWORK", "lost");
    };
    await expect(
      checkout.submit(
        [{ productId: morphine, qty: 1 }],
        { cashAmount: "40" },
        { prescriptionId },
        { approverUserId: pharmacistId, pin: "4321" },
      ),
    ).rejects.toMatchObject({ code: "CHECKOUT_UNCERTAIN" });
    const [pending] = checkout.pending();
    // The server refuses this only after finding no earlier attempt with the key: the sale never
    // happened, and only this co-signer could ever confirm it, so it must not stay pending.
    const refusal = new ApiError(403, "APPROVER_NOT_QUALIFIED", "Their registration has lapsed");
    checkoutReply = () => {
      throw refusal;
    };
    await expect(
      checkout.retry(pending!.draftId, { approverUserId: pharmacistId, pin: "4321" }),
    ).rejects.toBe(refusal);
    expect(checkout.pending()).toEqual([]);
    expect(
      local.db.prepare("SELECT status, error_code FROM checkout_draft").get(),
    ).toEqual({ status: "refused", error_code: "APPROVER_NOT_QUALIFIED" });
  });
});

describe("checkout safety", () => {
  it("refuses an empty or short tender against the VAT-inclusive total", async () => {
    catalogResponse.vatRatePercent = 18;
    const checkout = service();
    await expect(checkout.catalog()).resolves.toMatchObject({ vatRatePercent: 18 });
    // 3 x 2.50 = 7.50, VAT 1.35 (half up), total 8.85.
    await expect(
      checkout.submit([{ productId: paracetamol, qty: 3 }], {}),
    ).rejects.toMatchObject({ code: "TENDER_REQUIRED" });
    await expect(
      checkout.submit([{ productId: paracetamol, qty: 3 }], { cashAmount: "8.84" }),
    ).rejects.toMatchObject({ code: "TENDER_SHORT" });
    expect(calls.some((c) => c.path === "/sales/checkout")).toBe(false);
    await checkout.submit([{ productId: paracetamol, qty: 3 }], { cashAmount: "8.85" });
    expect(
      local.db.prepare("SELECT total_minor FROM checkout_draft").get(),
    ).toEqual({ total_minor: 885 });
  });

  it("keeps a resend pending when it is refused before the server could find the original", async () => {
    const checkout = service();
    await checkout.catalog();
    checkoutReply = () => {
      throw new ApiError(0, "NETWORK", "lost");
    };
    await expect(
      checkout.submit([{ productId: paracetamol, qty: 1 }], { cashAmount: "5" }),
    ).rejects.toMatchObject({ code: "CHECKOUT_UNCERTAIN" });
    const [pending] = checkout.pending();
    for (const refusal of [
      new ApiError(401, "HTTP_401", "Approver PIN is incorrect"),
      new ApiError(403, "PHARMACIST_APPROVAL_REQUIRED", "co-sign"),
      new ApiError(409, "BRANCH_SETUP_INCOMPLETE", "setup"),
    ]) {
      checkoutReply = () => {
        throw refusal;
      };
      await expect(checkout.retry(pending!.draftId)).rejects.toBe(refusal);
      expect(checkout.pending()).toHaveLength(1);
    }
    // Answered after the replay lookup: the sale never happened.
    checkoutReply = () => {
      throw new ApiError(400, "INSUFFICIENT_STOCK", "Not enough stock");
    };
    await expect(checkout.retry(pending!.draftId)).rejects.toBeInstanceOf(ApiError);
    expect(checkout.pending()).toEqual([]);
  });

  it("names who rang up an unconfirmed sale, since only they can confirm it", async () => {
    local.db
      .prepare(
        "INSERT INTO staff_session_log (work_session_id, staff_user_id, staff_name, enrollment_id, opened_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(workSessionId, staffUserId, "Nimal Perera", identity.enrollmentId, new Date().toISOString());
    const checkout = service();
    await checkout.catalog();
    checkoutReply = () => {
      throw new ApiError(0, "NETWORK", "lost");
    };
    await expect(
      checkout.submit([{ productId: paracetamol, qty: 1 }], { cashAmount: "5" }),
    ).rejects.toMatchObject({ code: "CHECKOUT_UNCERTAIN" });
    expect(checkout.pending()).toEqual([
      expect.objectContaining({ staffUserId, staffName: "Nimal Perera" }),
    ]);
  });

  it("won't resend a sale from a counter re-enrolled since it was rung up", async () => {
    const checkout = service();
    await checkout.catalog();
    checkoutReply = () => {
      throw new ApiError(0, "NETWORK", "lost");
    };
    await expect(
      checkout.submit([{ productId: paracetamol, qty: 1 }], { cashAmount: "5" }),
    ).rejects.toMatchObject({ code: "CHECKOUT_UNCERTAIN" });
    const [pending] = checkout.pending();
    identity = { ...identity, branchId: randomUUID(), enrollmentId: randomUUID() };
    await expect(checkout.retry(pending!.draftId)).rejects.toMatchObject({
      code: "DRAFT_OTHER_COUNTER",
    });
    expect(calls.filter((c) => c.path === "/sales/checkout")).toHaveLength(1);
  });
});

describe("line discounts and the manager co-sign (P2b #103)", () => {
  it("shows the branch's discount limit, defaulting to 10% when an older server sends none", async () => {
    const checkout = service();
    await expect(checkout.catalog()).resolves.toMatchObject({ maxDiscountPercent: 10 });
    (catalogResponse as Record<string, unknown>).maxDiscountPercent = 7.5;
    try {
      await expect(checkout.catalog()).resolves.toMatchObject({ maxDiscountPercent: 7.5 });
    } finally {
      delete (catalogResponse as Record<string, unknown>).maxDiscountPercent;
    }
  });

  it("sends each line's discount and charges the discounted, VAT-inclusive total", async () => {
    const checkout = service();
    catalogResponse.vatRatePercent = 10;
    await checkout.catalog();
    // 4 × 2.50 = 10.00, less 1.00 = 9.00, plus 10% VAT = 9.90.
    await expect(
      checkout.submit([{ productId: paracetamol, qty: 4, discountMinor: 100 }], { cashAmount: "9.89" }),
    ).rejects.toMatchObject({ code: "TENDER_SHORT" });
    await checkout.submit([{ productId: paracetamol, qty: 4, discountMinor: 100 }], { cashAmount: "9.90" });
    const sent = calls.find((c) => c.path === "/sales/checkout")!;
    expect(sent.opts.body).toEqual({
      items: [{ productId: paracetamol, qty: 4, unitPrice: "2.50", discountAmount: "1.00" }],
      payments: [{ method: "cash", amount: "9.90" }],
    });
  });

  it("refuses a discount bigger than its line before anything is sent", async () => {
    const checkout = service();
    await checkout.catalog();
    await expect(
      checkout.submit([{ productId: paracetamol, qty: 2, discountMinor: 501 }], { cashAmount: "5" }),
    ).rejects.toMatchObject({ code: "DISCOUNT_TOO_LARGE" });
    expect(calls.some((c) => c.path === "/sales/checkout")).toBe(false);
  });

  it("sends the manager's co-sign as discountApproval, keeping who approved but never the PIN", async () => {
    const checkout = service();
    await checkout.catalog();
    await checkout.submit(
      [{ productId: paracetamol, qty: 2, discountMinor: 200 }],
      { cashAmount: "3" },
      {},
      undefined,
      { approverUserId: managerId, pin: "8642" },
    );
    const sent = calls.find((c) => c.path === "/sales/checkout")!;
    expect(sent.opts.body).toMatchObject({ discountApproval: { approverUserId: managerId, pin: "8642" } });
    expect(sent.opts.body).not.toHaveProperty("pharmacistApproval");
    const row = local.db
      .prepare("SELECT request_json, co_signer_id, discount_co_signer_id FROM checkout_draft")
      .get() as { request_json: string; co_signer_id: string | null; discount_co_signer_id: string };
    expect(row).toMatchObject({ co_signer_id: null, discount_co_signer_id: managerId });
    expect(row.request_json).not.toContain("8642");
  });

  it("confirms an unanswered discounted sale with the same manager's PIN only", async () => {
    const checkout = service();
    await checkout.catalog();
    checkoutReply = () => {
      throw new ApiError(0, "NETWORK", "lost");
    };
    await expect(
      checkout.submit([{ productId: paracetamol, qty: 2, discountMinor: 200 }], { cashAmount: "3" }, {}, undefined, {
        approverUserId: managerId,
        pin: "8642",
      }),
    ).rejects.toMatchObject({ code: "CHECKOUT_UNCERTAIN" });
    const [pending] = checkout.pending();
    expect(pending).toMatchObject({ discountCoSignerId: managerId, coSignerId: null });
    await expect(
      checkout.retry(pending!.draftId, undefined, { approverUserId: randomUUID(), pin: "1111" }),
    ).rejects.toMatchObject({ code: "CO_SIGNER_CHANGED" });
    checkoutReply = () => saleResponse();
    await checkout.retry(pending!.draftId, undefined, { approverUserId: managerId, pin: "8642" });
    const [first, second] = calls.filter((c) => c.path === "/sales/checkout");
    expect(second!.opts.body).toEqual(first!.opts.body);
  });

  it("tells a refused discount co-sign apart from a refused pharmacist's PIN", async () => {
    const checkout = service();
    await checkout.catalog();
    checkoutReply = () => {
      throw new ApiError(403, "APPROVER_PIN_INCORRECT", "Incorrect till PIN", { coSign: "discount" });
    };
    await expect(
      checkout.submit([{ productId: paracetamol, qty: 2, discountMinor: 200 }], { cashAmount: "3" }, {}, undefined, {
        approverUserId: managerId,
        pin: "0000",
      }),
    ).rejects.toMatchObject({ code: "DISCOUNT_COSIGN_REFUSED", message: "Incorrect till PIN" });
    checkoutReply = () => {
      throw new ApiError(403, "APPROVER_PIN_INCORRECT", "Incorrect pharmacist PIN");
    };
    await expect(
      checkout.submit([{ productId: morphine, qty: 1 }], { cashAmount: "40" }, { prescriptionId }, {
        approverUserId: pharmacistId,
        pin: "0000",
      }),
    ).rejects.toMatchObject({ code: "APPROVER_PIN_INCORRECT" });
  });

  it("lists who can approve a discount, leaving out the person signed in", async () => {
    const checkout = service();
    await expect(checkout.discountApprovers()).resolves.toEqual([
      { userId: managerId, fullName: "Nimal Manager", hasPin: true },
    ]);
    expect(calls.map((c) => c.path)).toContain("/sales/pos/discount-approvers");
  });
});

describe("held carts", () => {
  it("holds with catalog totals and recalls only sellable product lines", async () => {
    const checkout = service();
    await checkout.catalog();
    await expect(
      checkout.hold([{ productId: paracetamol, qty: 3 }], "Blue shirt"),
    ).resolves.toEqual({ holdRef: "HOLD-0007" });
    expect(
      calls.find((c) => c.path === "/sales/holds")!.opts.body,
    ).toMatchObject({ itemCount: 3, total: "7.50", label: "Blue shirt" });
    await expect(checkout.recall(randomUUID())).resolves.toEqual({
      lines: [{ productId: paracetamol, qty: 2, discountMinor: 0 }],
      customerId,
      prescriptionId: null,
    });
  });

  it("keeps a line's discount with the hold, never an approval, and brings it back on recall", async () => {
    const checkout = service();
    await checkout.catalog();
    recallLines = [{ productId: paracetamol, qty: 2, discountAmount: "0.50" }, { productId: paracetamol, qty: 1, discountAmount: "-1" }];
    await checkout.hold([{ productId: paracetamol, qty: 2, discountMinor: 50 }], undefined);
    expect(calls.find((c) => c.path === "/sales/holds")!.opts.body).toMatchObject({
      total: "4.50",
      lines: [{ productId: paracetamol, qty: 2, discountAmount: "0.50" }],
    });
    await expect(checkout.recall(randomUUID())).resolves.toMatchObject({
      lines: [
        { productId: paracetamol, qty: 2, discountMinor: 50 },
        // A discount that isn't an amount comes back as none.
        { productId: paracetamol, qty: 1, discountMinor: 0 },
      ],
    });
  });

  it("holds with the customer and prescription under the web POS meta keys", async () => {
    const checkout = service();
    await checkout.catalog();
    await checkout.hold([{ productId: morphine, qty: 1 }], undefined, {
      customerId,
      prescriptionId,
    });
    expect(
      calls.find((c) => c.path === "/sales/holds")!.opts.body,
    ).toMatchObject({
      meta: { source: "desktop_counter", customerId, prescriptionId },
    });
  });
});
