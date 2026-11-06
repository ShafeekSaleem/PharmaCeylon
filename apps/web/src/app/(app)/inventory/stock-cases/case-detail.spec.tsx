import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { apiJson } from "@/lib/auth-client";
import { usePermissions } from "@/lib/permissions";
import { useAuth } from "@/lib/use-auth";
import { CaseDetail } from "./case-detail";
import StockCasesRoute from "./page";
import type { StockCaseDetail, StockCasePlan, StockCaseSummary } from "./types";

jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));
jest.mock("@/lib/use-auth", () => ({ useAuth: jest.fn() }));
jest.mock("@/lib/permissions", () => ({ usePermissions: jest.fn(), hasPermission: () => true }));
jest.mock("@/components/role-access", () => ({ RolePageGuard: ({ children }: { children: React.ReactNode }) => children }));
const replace = jest.fn();
let mockParams = new URLSearchParams();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: jest.fn() }),
  useSearchParams: () => mockParams,
  usePathname: () => "/inventory/stock-cases",
}));

const BATCH = "b-1";
const manager = { id: "u-manager", name: "Nimal Manager" };
const owner = { id: "u-owner", name: "Owner Perera" };

function detail(overrides: Partial<StockCaseDetail> = {}): StockCaseDetail {
  return {
    id: "case-1",
    status: "open",
    openedAt: "2026-11-06T05:00:00.000Z",
    resolvedAt: null,
    snapshot: { id: "snap", version: 3, generatedAt: "2026-11-06T03:00:00.000Z" },
    offline: {
      commandId: "cmd", counter: "Front", sequence: 2, occurredAt: "2026-11-06T04:00:00.000Z",
      signIn: { signInId: "s", staff: { id: "u-cashier", name: "Dilini Cashier" }, authenticatedAt: "2026-11-06T03:30:00.000Z" },
      syncedAt: "2026-11-06T05:00:00.000Z", uploadedBy: { id: "u-cashier", name: "Dilini Cashier" },
    },
    sale: {
      id: "sale-1", invoiceNo: "INV-2611-000042", status: "posted", stockPosting: "pending_reconciliation",
      soldAt: "2026-11-06T04:00:00.000Z", soldBy: { id: "u-cashier", name: "Dilini Cashier" },
      subtotal: "77.50", taxTotal: "13.95", grandTotal: "91.45", amountPaid: "96.45", changeDue: "5.00",
      items: [{ productId: "p", productName: "Paracetamol 500mg", batchId: BATCH, batchNo: "PCM-7", qty: 5, unitPrice: "15.50", lineTotal: "91.45" }],
      payments: [{ method: "cash", amount: "96.45", reference: null }],
    },
    batches: [{
      batchId: BATCH, batchNo: "PCM-7", expiryDate: "2027-11-01", productId: "p", productName: "Paracetamol 500mg", sku: "PCM",
      reason: "shortfall", soldQuantity: 5, availableQuantityAtSync: 3, shortfallQuantity: 2,
      pending: { thisCase: 5, otherOpenCases: [], total: 5 },
      stock: { onHand: 3, quarantined: 0, reserved: 0, available: 3 },
      blocked: true, heldByThisCase: true, timelineTruncated: false, timelineDigest: "a".repeat(64),
      timeline: [{
        id: "l1", occurredAt: "2026-11-06T04:30:00.000Z", movementType: "sale_out", bucket: "sellable", qtyDelta: -7,
        referenceType: "sale", referenceId: "s2", reference: "INV-2611-000041", reason: null, actor: owner,
      }],
      stocktakes: [], reservations: [], movementCandidates: [],
    }],
    plans: [],
    settlements: [],
    ...overrides,
  };
}

function plan(overrides: Partial<StockCasePlan> = {}): StockCasePlan {
  return {
    id: "plan-1", kind: "count_and_correct", links: [], note: null, status: "prepared", approvalVersion: 1,
    executionApprovalId: null, approvalState: "none", approvalReview: { expectedVersion: 1, expectedDigest: "d".repeat(64) },
    readyAtCounter: false, requester: manager, requestedAt: "2026-11-06T05:10:00.000Z", approver: null, approvedAt: null,
    executor: null, executedAt: null, executionCommandId: null, cancelledBy: null, cancelledAt: null,
    ...overrides,
  };
}

function renderDetail(d: StockCaseDetail, opts: { userId?: string; canSelfApprove?: boolean } = {}) {
  const handlers = {
    onPrepare: jest.fn().mockResolvedValue(true),
    onApprove: jest.fn().mockResolvedValue(true),
    onCancel: jest.fn().mockResolvedValue(true),
  };
  render(<CaseDetail detail={d} busy={false} userId={opts.userId ?? "u-owner"} canSelfApprove={opts.canSelfApprove ?? true} {...handlers} />);
  return handlers;
}

let uuids = 0;
beforeEach(() => {
  jest.clearAllMocks();
  mockParams = new URLSearchParams();
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    value: () => `00000000-0000-4000-8000-${String(++uuids).padStart(12, "0")}`,
    configurable: true,
  });
});

describe("offline stock cases (P5 #51)", () => {
  it("shows the offline sale, its receipt and payments, the pending units and the batch timeline", () => {
    renderDetail(detail());
    expect(screen.getByRole("heading", { name: /Sale INV-2611-000042/ })).toHaveTextContent("Stock pending");
    expect(screen.getByText(/Front · entry 2/)).toBeInTheDocument();
    expect(screen.getByText(/cash Rs|cash LKR|cash/)).toBeInTheDocument();
    const batch = screen.getByRole("region", { name: "Batch PCM-7" });
    expect(within(batch).getByText("Paused for sale")).toBeInTheDocument();
    expect(within(batch).getByText(/Short \(2 short\)/)).toBeInTheDocument();
    const timeline = within(batch).getByRole("table");
    expect(within(timeline).getByText("INV-2611-000041")).toBeInTheDocument();
    expect(within(timeline).getByText("-7")).toBeInTheDocument();
  });

  it("prepares a count-and-correct plan by default; nothing here moves stock", () => {
    const { onPrepare } = renderDetail(detail());
    // Stock doesn't cover the sale, and nothing has settled it, so the other kinds say why.
    expect(screen.getByText(/Stock does not cover the sale right now/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Link an existing settlement/ })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Note" }), { target: { value: "Shelf looks empty" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare plan" }));
    expect(onPrepare).toHaveBeenCalledWith({ kind: "count_and_correct", note: "Shelf looks empty" });
    expect(screen.queryByRole("button", { name: /resolve|execute|post/i })).toBeNull();
  });

  it("links a stocktake counted after the sale", () => {
    const d = detail();
    d.batches[0]!.stocktakes = [{
      stocktakeId: "st-1", stocktakeNumber: "ST-0009", status: "completed", lineId: "l", systemQty: 3, countedQty: 0,
      varianceQty: -3, countedAt: "2026-11-06T06:00:00.000Z", postedAt: "2026-11-06T06:10:00.000Z", countedBy: manager, settlesThisSale: true,
    }];
    const { onPrepare } = renderDetail(d);
    // The count already took the sale's units off, so posting them again is not offered.
    expect(screen.getByRole("radio", { name: /Post the sale now/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: /Link an existing settlement/ }));
    expect(screen.getByRole("combobox", { name: /What accounted for batch PCM-7/ })).toHaveDisplayValue(/ST-0009/);
    fireEvent.click(screen.getByRole("button", { name: "Prepare plan" }));
    expect(onPrepare).toHaveBeenCalledWith({
      kind: "link_existing_settlement", links: [{ batchId: BATCH, source: "stocktake", stocktakeId: "st-1" }],
    });
  });

  it("approves the exact plan shown, with one approval ID per content, unless it is the requester's own", () => {
    const { onApprove } = renderDetail(detail({ plans: [plan()] }));
    fireEvent.click(screen.getByRole("button", { name: "Approve plan" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve plan" }));
    expect(onApprove).toHaveBeenCalledTimes(2);
    expect(onApprove.mock.calls[0]![1]).toBe(onApprove.mock.calls[1]![1]);
    expect(onApprove.mock.calls[0]![0]).toMatchObject({ id: "plan-1" });
  });

  it("hides approval from a requester whose role can't approve its own", () => {
    renderDetail(detail({ plans: [plan()] }), { userId: "u-manager", canSelfApprove: false });
    expect(screen.queryByRole("button", { name: "Approve plan" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel plan" })).toBeInTheDocument();
  });

  it("hands an approved plan to the counter", () => {
    renderDetail(detail({ plans: [plan({ status: "approved", approvalState: "matches", readyAtCounter: true, approver: owner, approvedAt: "2026-11-06T05:20:00.000Z", executionApprovalId: "ap-1" })] }));
    expect(screen.getByText(/Approved — waiting at the counter/)).toBeInTheDocument();
    expect(screen.getByText(/Count the batches and settle the sale/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve plan" })).toBeNull();
  });

  it("warns that a changed plan needs fresh approval", () => {
    renderDetail(detail({ plans: [plan({ status: "approved", approvalState: "changed", approver: owner, executionApprovalId: "ap-1" })] }));
    expect(screen.getByText(/another offline sale now waits on one of these batches/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve plan" })).toBeInTheDocument();
  });

  it("shows how a resolved case was settled, with requester, approver and executor", () => {
    renderDetail(detail({
      status: "resolved",
      plans: [plan({ status: "executed", approvalState: "matches", approver: owner, approvedAt: "2026-11-06T05:20:00.000Z", executor: manager, executedAt: "2026-11-06T07:00:00.000Z" })],
      settlements: [{
        batchId: BATCH, method: "counted", soldQuantity: 5, onHandBefore: 3, pendingOnBatch: 5, countedQuantity: 0,
        countedAt: "2026-11-06T07:00:00.000Z", countedBy: manager, correctionQuantity: 2, postedQuantity: 5,
        linkedStocktakeId: null, linkedMovements: [],
      }],
    }));
    const settled = screen.getByRole("table", { name: "How each batch was settled" });
    expect(within(settled).getByText("Count by Nimal Manager")).toBeInTheDocument();
    expect(within(settled).getByText("+2")).toBeInTheDocument();
    expect(screen.getAllByRole("region", { name: "Resolution" })[0]).toHaveTextContent(/Owner Perera/);
  });

  it("lists the branch's open cases and opens the first", async () => {
    jest.mocked(useAuth).mockReturnValue({ branchId: "branch-a", user: { id: "u-owner" } } as never);
    jest.mocked(usePermissions).mockReturnValue({ permissionKeys: ["inventory.resolve_stock_cases"], canSelfApprove: true } as never);
    const summary: StockCaseSummary = {
      id: "case-1", status: "open", openedAt: "2026-11-06T05:00:00.000Z", resolvedAt: null, saleId: "sale-1",
      invoiceNo: "INV-2611-000042", soldAt: "2026-11-06T04:00:00.000Z", grandTotal: "91.45", soldBy: "Dilini Cashier",
      counter: "Front", batchCount: 1, pendingUnits: 5, shortfallUnits: 2, plan: null,
    };
    jest.mocked(apiJson).mockImplementation(async (path: string) =>
      (path.startsWith("/offline-stock-cases?") ? [summary] : detail()) as never);
    render(<StockCasesRoute />);
    expect(await screen.findByRole("button", { name: /INV-2611-000042 · 5 unit\(s\) pending/ })).toHaveTextContent("Needs a plan");
    await waitFor(() => expect(apiJson).toHaveBeenCalledWith("/offline-stock-cases/case-1"));
    expect(apiJson).toHaveBeenCalledWith("/offline-stock-cases?status=open");
  });
});
