import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { apiJson } from "@/lib/auth-client";
import { ApiError } from "@/lib/api-error";
import { SALES_QUEUE_ACCESS_DENIED } from "./sales-queue-access";
import SalesIncidentNotes from "./sales-incident-notes";
import SalesPaymentRecovery from "./sales-payment-recovery";
import SalesCollectedMoney from "./sales-collected-money";
import type {
  CollectedMoneyRow,
  PaymentRecoveryRow,
  SaleIncidentNoteRow,
} from "../types";

jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));
jest.mock("@/lib/use-auth", () => ({ useAuth: () => ({ branchId: "branch-a" }) }));

const incidentRow = (overrides: Partial<SaleIncidentNoteRow> = {}): SaleIncidentNoteRow => ({
  id: "note-1",
  recordId: "INC-0042",
  branchId: "branch-a",
  terminalId: "term-1",
  terminalLabel: "Till 1",
  registerLabel: "Counter 1",
  status: "accepted",
  heldReason: null,
  incidentCategory: "Card",
  description: "Drawer wouldn't open",
  recordedAt: "2026-11-20T10:00:00.000Z",
  receivedAt: "2026-11-20T10:05:00.000Z",
  recordedBy: { id: "u1", fullName: "Nimal Perera" },
  sale: { id: "sale-1", invoiceNo: "C1R-000186" },
  offlineCommandId: "cmd-1",
  href: "/sales/sale-1",
  ...overrides,
});

const paymentRow = (overrides: Partial<PaymentRecoveryRow> = {}): PaymentRecoveryRow => ({
  attemptId: "att-1",
  branchId: "branch-a",
  terminalId: "term-1",
  terminalLabel: "Counter 1",
  heldReason: "amount_mismatch",
  explanation: "Approved amount differs from collected.",
  amountMinor: 125000,
  providerReference: "REF-88",
  approvalCode: "A1",
  cardState: "Approved, amount mismatch",
  recordedAt: "2026-11-20T11:00:00.000Z",
  receivedAt: "2026-11-20T11:01:00.000Z",
  sale: { id: "sale-2", invoiceNo: "C1R-000187" },
  offlineCommandId: "cmd-2",
  clearsOnUpload: true,
  ...overrides,
});

const moneyRow = (overrides: Partial<CollectedMoneyRow> = {}): CollectedMoneyRow => ({
  id: "money-1",
  branchId: "branch-a",
  amountMinor: 365800,
  method: "card",
  providerReference: "PR-1",
  approvalCode: "77",
  approvedAt: "2026-11-20T09:00:00.000Z",
  collectedAt: "2026-11-20T09:05:00.000Z",
  shiftId: "shift-1",
  shiftNumber: "S-0042",
  staffUserId: "u1",
  staffName: "Ruwan Jayasuriya",
  settlementId: "set-1",
  journalReviewId: "rev-1",
  offlineCommandId: null,
  receiptNumber: null,
  status: "unresolved",
  ...overrides,
});

beforeEach(() => {
  jest.mocked(apiJson).mockReset();
});

describe("incident notes queue", () => {
  it("shows a calm no-access state on 403, not a red error", async () => {
    jest.mocked(apiJson).mockRejectedValueOnce(new ApiError("Forbidden", 403, {}));
    render(<SalesIncidentNotes />);
    expect(await screen.findByText("Insufficient permissions")).toBeInTheDocument();
    expect(screen.getByText(SALES_QUEUE_ACCESS_DENIED)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("lists rows, opens the drawer, and shows empty and error states", async () => {
    jest.mocked(apiJson).mockResolvedValueOnce({
      items: [incidentRow()],
      total: 1,
      page: 1,
      pageSize: 25,
      asOf: "2026-11-20T12:00:00.000Z",
    });
    render(<SalesIncidentNotes />);
    expect(await screen.findByText("Drawer wouldn't open")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Drawer wouldn't open"));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Actions come later.")).toBeInTheDocument();
    expect(within(screen.getByRole("dialog")).getByText("Category")).toBeInTheDocument();

    jest.mocked(apiJson).mockRejectedValueOnce(new Error("Queue unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Queue unavailable")).toBeInTheDocument();

    jest.mocked(apiJson).mockResolvedValueOnce({ items: [], total: 0, page: 1, pageSize: 25, asOf: "" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("No incident notes to review")).toBeInTheDocument();
  });
});

describe("payment recovery queue", () => {
  it("shows clears on upload pill and drawer fields", async () => {
    jest.mocked(apiJson).mockResolvedValue({
      items: [paymentRow()],
      total: 1,
      page: 1,
      pageSize: 25,
      asOf: "",
    });
    render(<SalesPaymentRecovery />);
    await screen.findByText("Counter 1");
    expect(screen.getAllByText("Clears on upload").length).toBeGreaterThan(1);
    fireEvent.click(screen.getByText("Counter 1"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Approved, amount mismatch")).toBeInTheDocument();
  });
});

describe("collected money queue", () => {
  it("marks every row unresolved and opens the drawer", async () => {
    jest.mocked(apiJson).mockResolvedValue({
      items: [moneyRow()],
      total: 1,
      page: 1,
      pageSize: 25,
      asOf: "",
    });
    render(<SalesCollectedMoney />);
    await screen.findByText("Ruwan Jayasuriya");
    expect(screen.getAllByText("Unresolved").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText("Ruwan Jayasuriya"));
    await waitFor(() => expect(screen.getByText("Receipt number")).toBeInTheDocument());
  });
});