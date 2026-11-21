import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

let branchId: string | null = "branch-a";
jest.mock("@/lib/use-auth", () => ({ useAuth: () => ({ branchId }) }));

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
  receivedAt: "2026-11-17T06:00:00.000Z",
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
  heldReason: "card_payment_mismatch",
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

function incidentCalls(): URLSearchParams[] {
  return jest
    .mocked(apiJson)
    .mock.calls.map(([path]) => String(path))
    .filter((path) => path.startsWith("/sales/incident-notes?"))
    .map((path) => new URLSearchParams(path.split("?")[1]));
}

beforeEach(() => {
  branchId = "branch-a";
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

  it("does not show a sort-order footer label", async () => {
    jest.mocked(apiJson).mockResolvedValue({
      items: [incidentRow()],
      total: 1,
      page: 1,
      pageSize: 25,
      asOf: "2026-11-20T12:00:00.000Z",
    });
    render(<SalesIncidentNotes />);
    await screen.findByText("Till 1");
    expect(screen.queryByText("Oldest first")).not.toBeInTheDocument();
  });

  it("requests open notes by default and switches to held on the status toggle", async () => {
    jest.mocked(apiJson).mockResolvedValue({
      items: [incidentRow()],
      total: 1,
      page: 1,
      pageSize: 25,
      asOf: "2026-11-20T12:00:00.000Z",
    });
    render(<SalesIncidentNotes />);
    await waitFor(() => expect(incidentCalls().at(-1)?.get("status")).toBe("open"));

    jest.mocked(apiJson).mockResolvedValueOnce({
      items: [
        incidentRow({
          status: "held",
          heldReason: "shift_unverified",
          description: "Shift never closed",
        }),
      ],
      total: 1,
      page: 1,
      pageSize: 25,
      asOf: "2026-11-20T12:00:00.000Z",
    });
    fireEvent.click(screen.getByRole("tab", { name: "Held" }));
    await waitFor(() => expect(incidentCalls().at(-1)?.get("status")).toBe("held"));
    expect(incidentCalls().at(-1)?.get("page")).toBe("1");
    fireEvent.click(screen.getAllByText("Till 1")[0]!);
    expect(
      within(screen.getByRole("dialog")).getByText(
        "Waiting for the shift this record cites to reach the server.",
      ),
    ).toBeInTheDocument();
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
    expect(await screen.findByText("3 days late")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Till 1"));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Actions come later.")).toBeInTheDocument();
    expect(within(screen.getByRole("dialog")).getByText("Terminal")).toBeInTheDocument();
    expect(within(screen.getByRole("dialog")).getByText("Drawer wouldn't open")).toBeInTheDocument();

    jest.mocked(apiJson).mockRejectedValueOnce(new Error("Queue unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Queue unavailable")).toBeInTheDocument();

    jest.mocked(apiJson).mockResolvedValueOnce({ items: [], total: 0, page: 1, pageSize: 25, asOf: "" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("No incident notes to review")).toBeInTheDocument();
  });

  it("clears the drawer and ignores stale responses when the branch changes", async () => {
    let resolveBranchA: (value: unknown) => void = () => {};
    jest.mocked(apiJson).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveBranchA = resolve;
        }),
    );

    const view = render(<SalesIncidentNotes />);

    jest.mocked(apiJson).mockResolvedValue({
      items: [incidentRow({ terminalLabel: "Till B" })],
      total: 1,
      page: 1,
      pageSize: 25,
      asOf: "2026-11-20T12:00:00.000Z",
    });

    branchId = "branch-b";
    view.rerender(<SalesIncidentNotes />);

    await act(async () => {
      resolveBranchA({
        items: [incidentRow({ terminalLabel: "Till stale" })],
        total: 1,
        page: 1,
        pageSize: 25,
        asOf: "2026-11-20T12:00:00.000Z",
      });
    });

    expect(await screen.findByText("Till B")).toBeInTheDocument();
    expect(screen.queryByText("Till stale")).not.toBeInTheDocument();
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
    expect(screen.getByText(/linked sale holds no card payment/i)).toBeInTheDocument();
    expect(screen.getAllByText("Clears on upload").length).toBeGreaterThan(1);
    fireEvent.click(screen.getByText("Counter 1"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Approved, amount mismatch")).toBeInTheDocument();
  });

  it("resets when the branch changes", async () => {
    jest.mocked(apiJson).mockResolvedValue({
      items: [paymentRow()],
      total: 1,
      page: 1,
      pageSize: 25,
      asOf: "",
    });
    const view = render(<SalesPaymentRecovery />);
    await screen.findByText("Counter 1");
    fireEvent.click(screen.getByText("Counter 1"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    branchId = "branch-b";
    view.rerender(<SalesPaymentRecovery />);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
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
    expect(screen.getByText("Card")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Ruwan Jayasuriya"));
    await waitFor(() => expect(screen.getByText("Receipt number")).toBeInTheDocument());
  });

  it("resets when the branch changes", async () => {
    jest.mocked(apiJson).mockResolvedValue({
      items: [moneyRow()],
      total: 1,
      page: 1,
      pageSize: 25,
      asOf: "",
    });
    const view = render(<SalesCollectedMoney />);
    await screen.findByText("Ruwan Jayasuriya");
    fireEvent.click(screen.getByText("Ruwan Jayasuriya"));
    branchId = "branch-b";
    view.rerender(<SalesCollectedMoney />);
    await waitFor(() => expect(screen.queryByText("Receipt number")).not.toBeInTheDocument());
  });
});
