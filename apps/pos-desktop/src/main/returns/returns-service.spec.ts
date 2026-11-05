import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, type ApiSession } from "../api/api-client";
import type { SecretProtector } from "../db/key-store";
import { migrations } from "../db/migrations";
import { DeviceKey } from "../device/device-key";
import { openLocalStore, type LocalStore } from "../local-store";
import type { Logger } from "../logging/logger";
import { SignedCommandService } from "../terminal/signed-commands";
import type { TerminalService } from "../terminal/terminal-service";
import { localDateKey, ReturnsService } from "./returns-service";

const protector: SecretProtector = {
  isAvailable: () => true,
  protect: (p) => Buffer.from(p),
  unprotect: (b) => b.toString(),
};
const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined, flush: async () => {} };
const key = DeviceKey.generate();
const identity = {
  tenantId: randomUUID(),
  branchId: randomUUID(),
  terminalId: randomUUID(),
  enrollmentId: randomUUID(),
  keyId: key.keyId,
};
const staff = { workSessionId: randomUUID(), staffUserId: randomUUID(), staffName: "Sachini R.", openedAt: "" };
const saleId = randomUUID();
const requestId = randomUUID();
const approvalId = randomUUID();
const [stripsBatch, losartanBatch, strips, losartan] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];

type Sent = { method: string; path: string; body: any; branchId?: string };
let dir: string;
let local: LocalStore;
let sent: Sent[];
let prepared: Record<string, unknown>;
let byInvoice: () => unknown;

function service() {
  const api = {
    request: async (method: string, path: string, opts: { body?: any; branchId?: string } = {}) => {
      sent.push({ method, path, body: opts.body, branchId: opts.branchId });
      if (path.startsWith("/sales/pos/by-invoice")) return byInvoice();
      if (path === `/sales/${saleId}/returnable`)
        return {
          saleId,
          requiresPharmacist: true,
          refundApprovalThreshold: "5000.00",
          refunds: [{ returnNumber: "RET-1", amount: "640.00", createdAt: "2026-10-30T05:00:00.000Z" }],
          lines: [
            {
              productId: strips, batchId: stripsBatch, productName: "Accu-Chek Active Strips ×50", sku: "ACA",
              batchNo: "ACA-2210", expiryDate: "2027-05-31", unit: "box", soldQty: 1, remainingQty: 1,
              lineTotal: "4850.00", isControlled: false, requiresPrescription: false,
            },
            {
              productId: losartan, batchId: losartanBatch, productName: "Losartan 50mg", sku: "LS",
              batchNo: "LS-4410", expiryDate: "2028-01-31", unit: "tabs", soldQty: 30, remainingQty: 30,
              lineTotal: "900.00", isControlled: false, requiresPrescription: true,
            },
          ],
        };
      if (path.startsWith("/sales/history"))
        return {
          items: [
            {
              id: saleId, invoiceNo: "INV-T1-1029-0188", status: "posted", soldAt: "2026-10-29T11:12:00.000Z",
              grandTotal: "6992.00", itemCount: 5, customerName: "Ruwan Jayawardena", customerPhone: "071 482 0937",
              sellerName: "Kasun J.", paymentMethods: ["card"], summary: "1× Strips",
            },
          ],
          total: 1, page: 1, pageSize: 100,
        };
      if (path === "/sales/refunds")
        return [
          { returnNumber: "RET-9", amount: "300.00", createdAt: new Date("2026-11-01T06:00:00").toISOString(),
            reasonCode: "damaged", sale: { invoiceNo: "INV-9" }, refundedTo: [{ method: "cash", amount: "300.00" }],
            refundedBy: { fullName: "Sachini R." }, approvedBy: null, items: [{}] },
          { returnNumber: "RET-8", amount: "90.00", createdAt: new Date("2026-10-31T06:00:00").toISOString(),
            reasonCode: "other", sale: null, refundedTo: [], refundedBy: null, approvedBy: null, items: [] },
        ];
      if (path === `/sales/${saleId}/refund-requests`) return prepared;
      if (path === "/terminal-commands/prepare")
        return {
          contractVersion: 1, kind: "online_operation", commandId: randomUUID(), identity,
          session: { registerId: randomUUID(), tillId: randomUUID(), workSessionId: staff.workSessionId, staffUserId: staff.staffUserId },
          operation: opts.body.operation, issuedAt: 1, expiresAt: 2, serverNonce: "e".repeat(64),
          body: opts.body.body, approvalEvidenceId: opts.body.approvalEvidenceId,
          pharmacistEvidenceId: null, operatingHoursExceptionId: null,
        };
      if (path === "/terminal-commands/execute")
        return {
          contractVersion: 1, kind: "online_command_receipt", receiptId: randomUUID(), replayed: false,
          result: {
            type: "sale_refund.executed", refundRequestId: requestId, approvalId: prepared.executionApprovalId,
            goodsReturnId: randomUUID(), amountMinor: 485000, refundedTo: [{ method: "card", amountMinor: 485000 }],
            effect: "applied",
          },
        };
      throw new Error(path);
    },
  };
  const terminal = {
    current: () => ({ staff, identity, key }),
    attendCommand: async () => ({ proofId: randomUUID(), purpose: "command", expiresAt: 0 }),
  };
  const commands = new SignedCommandService({
    db: local.db, api: api as unknown as ApiSession, terminal: terminal as unknown as TerminalService, logger,
  });
  return new ReturnsService({
    api: api as unknown as ApiSession,
    terminal: terminal as unknown as TerminalService,
    commands,
    now: () => new Date("2026-11-01T14:32:00"),
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pos-returns-spec-"));
  local = openLocalStore(dir, protector, migrations);
  sent = [];
  byInvoice = () => ({
    id: saleId, invoiceNo: "INV-T1-1029-0188", status: "partially_refunded", soldAt: "2026-10-29T11:12:00.000Z",
    grandTotal: "6992.00", customer: { fullName: "Ruwan Jayawardena", phone: "071 482 0937" },
    seller: { fullName: "Kasun J." },
    payments: [
      { method: "card", amount: "6992.00", reference: "Visa 4417" },
      { method: "card", amount: "-640.00", reference: "POS refund RET-1" },
    ],
  });
  prepared = {
    id: requestId, requestNumber: "RFR-12", amount: "4850.00", readyAtCounter: true, executionApprovalId: null,
    requester: { fullName: "Sachini R." }, approver: null,
  };
});
afterEach(() => {
  local.db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("Returns: finding the sale", () => {
  it("reads the sale and what earlier refunds have left of each line, at this counter's branch", async () => {
    const sale = await service().findSale("INV-T1-1029-0188");
    expect(sent[0]).toMatchObject({
      method: "GET",
      path: "/sales/pos/by-invoice?invoiceNo=INV-T1-1029-0188",
      branchId: identity.branchId,
    });
    expect(sale).toMatchObject({
      invoiceNo: "INV-T1-1029-0188",
      sellerName: "Kasun J.",
      customer: { fullName: "Ruwan Jayawardena", phone: "071 482 0937" },
      // The earlier refund's negative row is not how the customer paid.
      payments: [{ method: "card", amount: "6992.00", reference: "Visa 4417" }],
      refundLimit: "5000.00",
      earlierRefunds: [{ returnNumber: "RET-1" }],
      needsPharmacist: true,
    });
    expect(sale.lines[1]).toMatchObject({
      name: "Losartan 50mg",
      soldQty: 30,
      remainingQty: 30,
      paidTotal: "900.00",
      requiresPrescription: true,
      expiryDate: "2028-01-31",
    });
  });

  it("says plainly when no sale matches", async () => {
    byInvoice = () => {
      throw new ApiError(404, "NOT_FOUND", "No sale found for invoice X");
    };
    await expect(service().findSale("INV-404")).rejects.toMatchObject({ code: "SALE_NOT_FOUND" });
  });

  it("searches the history by phone, amount, day and the signed-in seller", async () => {
    const rows = await service().searchSales({
      customerPhone: "071 482 0937",
      minTotal: "6600.00",
      maxTotal: "7300.00",
      from: "2026-10-29",
      to: "2026-10-29",
      soldByMe: true,
      paymentMethod: "card",
    });
    const url = new URL(`http://x${sent[0]!.path}`);
    expect(url.pathname).toBe("/sales/history");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      pageSize: "100",
      customerPhone: "071 482 0937",
      minTotal: "6600.00",
      maxTotal: "7300.00",
      from: "2026-10-29",
      to: "2026-10-29",
      paymentMethod: "card",
      soldBy: staff.staffUserId,
    });
    expect(rows).toEqual([expect.objectContaining({ invoiceNo: "INV-T1-1029-0188", customerPhone: "071 482 0937" })]);
  });

  it("lists only today's refunds", async () => {
    const rows = await service().today();
    expect(rows.map((r) => r.returnNumber)).toEqual(["RET-9"]);
    expect(rows[0]).toMatchObject({ refundedBy: "Sachini R.", itemCount: 1, invoiceNo: "INV-9" });
  });

  it("reads the counter's own calendar day", () => {
    expect(localDateKey(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });
});

describe("Returns: refunding", () => {
  const input = {
    saleId,
    lines: [{ productId: strips, batchId: stripsBatch, qty: 1, disposition: "restock" as const }],
    reasonCode: "wrong_item" as const,
    note: "His meter needs Accu-Chek Instant strips.",
  };

  it("prepares the refund and executes it here through the signed command", async () => {
    const outcome = await service().submit(input);
    const prepare = sent.find((s) => s.path === `/sales/${saleId}/refund-requests`)!;
    expect(prepare).toMatchObject({
      method: "POST",
      branchId: identity.branchId,
      body: {
        reasonCode: "wrong_item",
        reason: "His meter needs Accu-Chek Instant strips.",
        items: input.lines,
      },
    });
    // Back the way it was paid unless the cashier chose a method.
    expect(prepare.body).not.toHaveProperty("refundMethod");
    const signed = sent.find((s) => s.path === "/terminal-commands/prepare")!;
    expect(signed.body).toMatchObject({
      operation: "POST /api/v1/sales/refund-requests/:id/execute",
      body: { refundRequestId: requestId },
      approvalEvidenceId: null,
      workSessionId: staff.workSessionId,
    });
    expect(outcome).toEqual({
      status: "refunded",
      refund: {
        requestNumber: "RFR-12",
        amountMinor: 485000,
        refundedTo: [{ method: "card", amountMinor: 485000 }],
        alreadyApplied: false,
        requestedBy: "Sachini R.",
        approvedBy: null,
      },
    });
  });

  it("over the limit, a refund its preparer approved executes with that approval", async () => {
    prepared = { ...prepared, amount: "6300.00", executionApprovalId: approvalId, approver: { fullName: "Dilini F." } };
    const outcome = await service().submit({ ...input, refundMethod: "cash" });
    expect(sent.find((s) => s.path === `/sales/${saleId}/refund-requests`)!.body).toMatchObject({ refundMethod: "cash" });
    expect(sent.find((s) => s.path === "/terminal-commands/prepare")!.body).toMatchObject({ approvalEvidenceId: approvalId });
    expect(outcome).toMatchObject({ status: "refunded", refund: { approvedBy: "Dilini F." } });
  });

  it("over the limit without approval, sends it for approval on the web and moves nothing", async () => {
    prepared = { ...prepared, amount: "6300.00", readyAtCounter: false };
    const outcome = await service().submit(input);
    expect(outcome).toEqual({
      status: "awaiting_approval",
      refundRequestId: requestId,
      requestNumber: "RFR-12",
      amount: "6300.00",
    });
    expect(sent.some((s) => s.path.startsWith("/terminal-commands"))).toBe(false);
  });
});
