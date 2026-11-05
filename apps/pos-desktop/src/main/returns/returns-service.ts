import type {
  IpcInput,
  RefundToday,
  ReturnOutcome,
  ReturnSale,
  SaleFound,
} from "../../shared/ipc-contract";
import { ApiError, type ApiSession } from "../api/api-client";
import type { SignedCommandService } from "../terminal/signed-commands";
import { ActionFailure, type TerminalService } from "../terminal/terminal-service";

type RawSale = {
  id: string;
  invoiceNo: string;
  status: string;
  soldAt: string;
  grandTotal: string;
  customer: { fullName: string; phone: string | null } | null;
  seller: { fullName: string } | null;
  payments: { method: string; amount: string; reference: string | null }[];
};

type RawReturnable = {
  saleId: string;
  requiresPharmacist: boolean;
  refundApprovalThreshold: string | null;
  refunds: { returnNumber: string; amount: string; createdAt: string }[];
  lines: {
    productId: string;
    batchId: string;
    productName: string;
    sku: string;
    batchNo: string;
    expiryDate: string | null;
    unit: string | null;
    soldQty: number;
    remainingQty: number;
    lineTotal: string;
    isControlled: boolean;
    requiresPrescription: boolean;
  }[];
};

type RawHistory = {
  items: {
    id: string;
    invoiceNo: string;
    status: string;
    soldAt: string;
    grandTotal: string;
    itemCount: number;
    customerName: string | null;
    customerPhone?: string | null;
    sellerName: string | null;
    paymentMethods: string[];
    summary: string;
  }[];
};

type RawRefund = {
  returnNumber: string;
  amount: string;
  createdAt: string;
  reasonCode: string | null;
  sale: { invoiceNo: string } | null;
  refundedTo: { method: string; amount: string }[];
  refundedBy: { fullName: string } | null;
  approvedBy: { fullName: string } | null;
  items: unknown[];
};

type RawPrepared = {
  id: string;
  requestNumber: string;
  amount: string;
  readyAtCounter: boolean;
  executionApprovalId: string | null;
  requester: { fullName: string } | null;
  approver: { fullName: string } | null;
};

const EXECUTE = "POST /api/v1/sales/refund-requests/:id/execute" as const;

/** The counter's calendar day, as the server's `from`/`to` read it (the tenant's zone is the counter's). */
export function localDateKey(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/**
 * The Returns page (P2b): find a sale with or without its receipt, then refund it here. A refund
 * is prepared on the server like a web one (`POST /sales/:id/refund-requests`) and, when nothing
 * more is needed, executed at once through the signed command, so the counter has one way to
 * move refund stock and money. At or over the tenant's limit, someone who may approve their own
 * refunds approves it as they prepare it; anyone else's request waits for approval on the web and
 * comes back under "From web".
 */
export class ReturnsService {
  constructor(
    private readonly deps: {
      api: ApiSession;
      terminal: TerminalService;
      commands: SignedCommandService;
      now?: () => Date;
    },
  ) {}

  private current() {
    const current = this.deps.terminal.current();
    if (!current) throw new ActionFailure("NOT_SIGNED_IN", "Sign in at this counter first.");
    return current;
  }

  private get<T>(path: string) {
    return this.deps.api.request<T>("GET", path, { branchId: this.current().identity.branchId });
  }

  async findSale(invoiceNo: string): Promise<ReturnSale> {
    let sale: RawSale;
    try {
      sale = await this.get<RawSale>(`/sales/pos/by-invoice?${new URLSearchParams({ invoiceNo })}`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404)
        throw new ActionFailure(
          "SALE_NOT_FOUND",
          `No sale at this branch matches ${invoiceNo.trim()}. Check the number on the receipt.`,
        );
      throw error;
    }
    const returnable = await this.get<RawReturnable>(`/sales/${sale.id}/returnable`);
    return {
      saleId: sale.id,
      invoiceNo: sale.invoiceNo,
      status: sale.status,
      soldAt: new Date(sale.soldAt).toISOString(),
      grandTotal: sale.grandTotal,
      sellerName: sale.seller?.fullName ?? null,
      customer: sale.customer ? { fullName: sale.customer.fullName, phone: sale.customer.phone } : null,
      payments: sale.payments
        .filter((p) => Number(p.amount) > 0)
        .map((p) => ({ method: p.method, amount: p.amount, reference: p.reference })),
      needsPharmacist: returnable.requiresPharmacist,
      refundLimit: returnable.refundApprovalThreshold,
      earlierRefunds: returnable.refunds ?? [],
      lines: returnable.lines.map((line) => ({
        productId: line.productId,
        batchId: line.batchId,
        name: line.productName,
        sku: line.sku,
        batchNo: line.batchNo,
        expiryDate: line.expiryDate ?? null,
        unit: line.unit ?? null,
        soldQty: line.soldQty,
        remainingQty: line.remainingQty,
        paidTotal: line.lineTotal,
        isControlled: line.isControlled,
        requiresPrescription: line.requiresPrescription,
      })),
    };
  }

  async searchSales(filter: IpcInput<"returnSearchSales">): Promise<SaleFound[]> {
    const params = new URLSearchParams({ pageSize: "100" });
    if (filter.customerPhone) params.set("customerPhone", filter.customerPhone);
    if (filter.minTotal) params.set("minTotal", filter.minTotal);
    if (filter.maxTotal) params.set("maxTotal", filter.maxTotal);
    if (filter.from) params.set("from", filter.from);
    if (filter.to) params.set("to", filter.to);
    if (filter.paymentMethod) params.set("paymentMethod", filter.paymentMethod);
    if (filter.soldByMe) params.set("soldBy", this.current().staff.staffUserId);
    const page = await this.get<RawHistory>(`/sales/history?${params}`);
    return page.items.map((row) => ({
      saleId: row.id,
      invoiceNo: row.invoiceNo,
      status: row.status,
      soldAt: new Date(row.soldAt).toISOString(),
      grandTotal: row.grandTotal,
      itemCount: row.itemCount,
      customerName: row.customerName,
      customerPhone: row.customerPhone ?? null,
      sellerName: row.sellerName,
      paymentMethods: row.paymentMethods,
      summary: row.summary,
    }));
  }

  /** Refunds made at this branch since the counter's midnight. */
  async today(): Promise<RefundToday[]> {
    const rows = await this.get<RawRefund[]>("/sales/refunds");
    const today = localDateKey((this.deps.now ?? (() => new Date()))());
    return rows
      .filter((row) => localDateKey(new Date(row.createdAt)) === today)
      .map((row) => ({
        returnNumber: row.returnNumber,
        invoiceNo: row.sale?.invoiceNo ?? null,
        amount: row.amount,
        createdAt: new Date(row.createdAt).toISOString(),
        reasonCode: row.reasonCode,
        refundedTo: row.refundedTo,
        refundedBy: row.refundedBy?.fullName ?? null,
        approvedBy: row.approvedBy?.fullName ?? null,
        itemCount: row.items.length,
      }));
  }

  async submit(input: IpcInput<"submitReturn">): Promise<ReturnOutcome> {
    const { identity } = this.current();
    const prepared = await this.deps.api.request<RawPrepared>(
      "POST",
      `/sales/${input.saleId}/refund-requests`,
      {
        branchId: identity.branchId,
        body: {
          reasonCode: input.reasonCode,
          ...(input.note ? { reason: input.note } : {}),
          items: input.lines,
          ...(input.refundMethod ? { refundMethod: input.refundMethod } : {}),
        },
      },
    );
    if (!prepared.readyAtCounter)
      return {
        status: "awaiting_approval",
        refundRequestId: prepared.id,
        requestNumber: prepared.requestNumber,
        amount: prepared.amount,
      };
    const receipt = await this.deps.commands.execute(
      EXECUTE,
      { refundRequestId: prepared.id },
      prepared.executionApprovalId,
    );
    const { result } = receipt;
    return {
      status: "refunded",
      refund: {
        requestNumber: prepared.requestNumber,
        amountMinor: result.amountMinor,
        refundedTo: result.refundedTo.map((r) => ({ method: r.method, amountMinor: r.amountMinor })),
        alreadyApplied: result.effect === "already_applied",
        requestedBy: prepared.requester?.fullName ?? null,
        approvedBy: prepared.approver?.fullName ?? null,
      },
    };
  }
}
