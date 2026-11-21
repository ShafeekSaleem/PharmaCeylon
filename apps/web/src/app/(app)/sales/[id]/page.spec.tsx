import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import SaleDetailPage from "./page";
import { apiJson } from "@/lib/auth-client";
import type { SaleDetail } from "../types";

const push = jest.fn();
const setLastSegmentLabel = jest.fn();
const searchParams = new URLSearchParams();
jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "sale-1" }),
  useRouter: () => ({ push }),
  useSearchParams: () => searchParams,
}));
jest.mock("@/lib/page-chrome-context", () => ({ usePageChrome: () => ({ setLastSegmentLabel }) }));
jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));
// The refund panel has its own spec.
jest.mock("../components/sale-refund-panel", () => ({ SaleRefundPanel: () => null }));

function sale(overrides: Partial<SaleDetail> = {}): SaleDetail {
  return {
    id: "sale-1",
    invoiceNo: "INV-2610-000042",
    status: "partially_refunded",
    soldAt: "2026-10-20T04:00:00.000Z",
    subtotal: "1000.00",
    discountTotal: "50.00",
    taxTotal: "0.00",
    grandTotal: "950.00",
    amountPaid: "1000.00",
    changeDue: "50.00",
    costTotal: null,
    notes: null,
    branch: { id: "branch-b", name: "Kandy" },
    customer: { id: "customer-1", fullName: "Kamala Silva", phone: "0771234567" },
    prescription: { id: "rx-1", rxNumber: "RX-17", patientName: "Kamala Silva", doctorName: "Fernando" },
    seller: { id: "user-cashier", fullName: "Nimal Perera" },
    dispenser: { id: "user-pharmacist", fullName: "Ruwan Jayasuriya" },
    items: [
      {
        id: "item-1",
        qty: 4,
        unitPrice: "250.00",
        discountAmount: "50.00",
        taxAmount: "0.00",
        lineTotal: "950.00",
        unitCost: null,
        product: { id: "product-1", name: "Amoxicillin 500mg", sku: "AMX-500", unit: "capsule" },
        batch: { id: "batch-1", batchNo: "B-77", expiryDate: "2027-06-30" },
      },
    ],
    payments: [
      { id: "pay-1", method: "cash", amount: "1000.00", reference: null, createdAt: "2026-10-20T04:00:00.000Z" },
      {
        id: "pay-2",
        method: "cash",
        amount: "-237.50",
        reference: "POS refund RET-2026-00003",
        createdAt: "2026-10-21T04:00:00.000Z",
      },
    ],
    refunds: [{ id: "return-1", returnNumber: "RET-2026-00003", amount: "237.50", createdAt: "2026-10-21T04:00:00.000Z" }],
    channel: "desktop_online",
    terminal: { id: "term-1", label: "Front desk" },
    register: { id: "reg-1", tillId: "till-1", label: "Counter 1" },
    shift: {
      id: "shift-1",
      shiftNumber: "S-0042",
      openedAt: "2026-10-20T08:14:00.000Z",
      closedAt: null,
    },
    ...overrides,
  };
}

const SETTINGS = {
  receiptPaperSize: "80mm",
  receiptHeaderText: "PharmaCeylon Kandy",
  receiptFooterText: "Thank you",
  receiptShowLogo: false,
  receiptShowVatBreakdown: true,
  receiptShowStaffName: true,
};

function mockApi(detail: SaleDetail | Error) {
  jest.mocked(apiJson).mockImplementation(async (path: string) => {
    if (path === "/sales/history/sale-1") {
      if (detail instanceof Error) throw detail;
      return detail;
    }
    if (path === "/tenant/settings") return SETTINGS;
    if (path === "/tenant/profile") return { displayName: "PharmaCeylon", logoUrl: null };
    throw new Error(`Unexpected request ${path}`);
  });
}

beforeEach(() => {
  push.mockReset();
  setLastSegmentLabel.mockReset();
  searchParams.forEach((_, key) => searchParams.delete(key));
  document.body.className = "";
});

it("shows the sale's items, payments, customer and prescription", async () => {
  mockApi(sale());
  render(<SaleDetailPage />);

  expect(await screen.findByRole("heading", { name: "INV-2610-000042" })).toBeInTheDocument();
  expect(apiJson).toHaveBeenCalledWith("/sales/history/sale-1");
  expect(setLastSegmentLabel).toHaveBeenCalledWith("INV-2610-000042");

  const details = screen.getByRole("region", { name: "Sale details" });
  expect(within(details).getByText("Partly refunded")).toBeInTheDocument();
  expect(within(details).getByText("Desktop")).toBeInTheDocument();
  expect(within(details).getByText("Counter 1")).toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "Receipt" })).getByText(
    "Receipt and invoice use the same number.",
  )).toBeInTheDocument();
  expect(within(details).getByText("Nimal Perera")).toBeInTheDocument();
  expect(within(details).getByText("Ruwan Jayasuriya")).toBeInTheDocument();
  expect(within(details).getByRole("link", { name: "Kamala Silva" })).toHaveAttribute(
    "href",
    "/customers?open=customer-1",
  );
  expect(within(details).getByRole("link", { name: "RX-17" })).toHaveAttribute("href", "/prescriptions?q=RX-17");

  const items = screen.getByRole("region", { name: "Items" });
  expect(within(items).getByText("Amoxicillin 500mg")).toBeInTheDocument();
  expect(within(items).getByText("Exp 06/2027")).toBeInTheDocument();

  const payments = screen.getByRole("region", { name: "Payments" });
  expect(within(payments).getByText("Refund to cash")).toBeInTheDocument();
  expect(within(payments).getByText(/POS refund RET-2026-00003/)).toBeInTheDocument();

  expect(within(screen.getByRole("region", { name: "Refunds" })).getByText("RET-2026-00003")).toBeInTheDocument();
});

it("shows a dash for costs the API withheld, and the figure when it didn't", async () => {
  mockApi(sale());
  const { unmount } = render(<SaleDetailPage />);
  const totals = await screen.findByRole("region", { name: "Totals" });
  expect(within(totals).getByText("Cost of goods").nextSibling).toHaveTextContent("—");
  expect(within(totals).getByText(/Historical cost is unavailable because unit costs were not saved/)).toBeInTheDocument();
  unmount();

  mockApi(
    sale({ costTotal: "482.00", items: [{ ...sale().items[0]!, unitCost: "120.50" }] }),
  );
  render(<SaleDetailPage />);
  expect(await screen.findByText("LKR 482.00")).toBeInTheDocument();
  expect(screen.getByText("LKR 120.50")).toBeInTheDocument();
});

it("opens a receipt copy that is marked as a copy and prints only the receipt", async () => {
  mockApi(sale());
  const print = jest.fn();
  Object.defineProperty(window, "print", { configurable: true, value: print });
  render(<SaleDetailPage />);

  fireEvent.click(await screen.findByRole("button", { name: "Receipt copy" }));

  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("Copy")).toBeInTheDocument();
  expect(within(dialog).getByText(/Not the original receipt/)).toBeInTheDocument();
  expect(await within(dialog).findByText("PharmaCeylon Kandy")).toBeInTheDocument();
  expect(within(dialog).getByText("Thank you")).toBeInTheDocument();
  // Tendered payments only: the later refund isn't part of the receipt.
  expect(within(dialog).queryByText("LKR -237.50")).not.toBeInTheDocument();

  // The print copy sits directly under <body>, and carries the same mark.
  const printCopy = screen.getByTestId("receipt-print-copy");
  expect(printCopy.parentElement).toBe(document.body);
  expect(within(printCopy).getByText("Copy")).toBeInTheDocument();
  expect(printCopy).toHaveAttribute("data-paper-size", "80mm");

  fireEvent.click(within(dialog).getByRole("button", { name: /Print or save as PDF/ }));
  expect(document.body.classList.length).toBe(1);
  await waitFor(() => expect(print).toHaveBeenCalledTimes(1));

  fireEvent(window, new Event("afterprint"));
  expect(document.body.classList.length).toBe(0);
});

it("shows a C1R receipt without the same-number line and no Till row without a till name", async () => {
  mockApi(
    sale({
      invoiceNo: "INV-2610-000186",
      status: "posted",
      offlineReceipt: {
        receiptNumber: "C1R-000186",
        recordedAt: "2026-10-20T03:48:00.000Z",
      },
      register: { id: "reg-1", tillId: "till-1", label: "Counter 1" },
      shift: {
        id: "shift-1",
        shiftNumber: "S-0042",
        openedAt: "2026-10-20T08:14:00.000Z",
        closedAt: null,
      },
    }),
  );
  render(<SaleDetailPage />);
  expect(await screen.findByRole("heading", { name: "INV-2610-000186" })).toBeInTheDocument();
  const receipt = screen.getByRole("region", { name: "Receipt" });
  expect(within(receipt).getByText("C1R-000186")).toBeInTheDocument();
  expect(within(receipt).getByText(/Recorded .+ 09:18 Asia\/Colombo/)).toBeInTheDocument();
  expect(within(receipt).getByText("Invoice INV-2610-000186")).toBeInTheDocument();
  const details = screen.getByRole("region", { name: "Sale details" });
  expect(within(details).queryByText("Till", { selector: "dt" })).not.toBeInTheDocument();
});

it("shows syncedAt on the receipt card when the API provides it", async () => {
  mockApi(
    sale({
      invoiceNo: "INV-2610-000186",
      offlineReceipt: {
        receiptNumber: "C1R-000186",
        recordedAt: "2026-10-20T03:48:00.000Z",
        syncedAt: "2026-10-20T04:30:00.000Z",
      },
    }),
  );
  render(<SaleDetailPage />);
  const receipt = await screen.findByRole("region", { name: "Receipt" });
  expect(within(receipt).getByText(/Synced .+ 10:00 Asia\/Colombo/)).toBeInTheDocument();
});

it("shows the held reconciliation note whenever offlineSyncState is held", async () => {
  mockApi(
    sale({
      status: "posted",
      offlineSyncState: "held",
      reconciliationCaseId: null,
      offlineReceipt: null,
    }),
  );
  render(<SaleDetailPage />);
  const details = await screen.findByRole("region", { name: "Sale details" });
  expect(within(details).getByText("Held")).toBeInTheDocument();
  expect(
    screen.getByText(/This sale is synced\. Stock posting is waiting on an open reconciliation case\./),
  ).toBeInTheDocument();
  expect(screen.queryByText(/read only/)).not.toBeInTheDocument();
});

it("links the reconciliation case when reconciliationCaseId is set", async () => {
  mockApi(
    sale({
      status: "posted",
      offlineSyncState: "held",
      reconciliationCaseId: "case-2148",
      offlineReceipt: {
        receiptNumber: "C1R-000186",
        recordedAt: "2026-10-20T03:48:00.000Z",
        syncedAt: "2026-10-20T04:30:00.000Z",
      },
    }),
  );
  render(<SaleDetailPage />);
  const details = await screen.findByRole("region", { name: "Sale details" });
  expect(within(details).getByText("Completed")).toBeInTheDocument();
  expect(within(details).getByText("Held")).toBeInTheDocument();
  expect(screen.getByText(/Reconciliation case/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "case-2148" })).toHaveAttribute(
    "href",
    "/inventory/stock-cases?caseId=case-2148",
  );
  expect(screen.getByText(/\(read only\)\./)).toBeInTheDocument();
});

it("opens receipt copy from a list deep link", async () => {
  searchParams.set("receipt", "1");
  mockApi(sale());
  render(<SaleDetailPage />);
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
});

it("explains a sale it can't show", async () => {
  mockApi(new Error("Sale not found"));
  render(<SaleDetailPage />);

  expect(await screen.findByText("Sale not found")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Back to sales history" })).toHaveAttribute("href", "/sales");
});
