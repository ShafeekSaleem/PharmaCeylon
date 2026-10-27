import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import SaleDetailPage from "./page";
import { apiJson } from "@/lib/auth-client";
import type { SaleDetail } from "../types";

const push = jest.fn();
const setLastSegmentLabel = jest.fn();
jest.mock("next/navigation", () => ({ useParams: () => ({ id: "sale-1" }), useRouter: () => ({ push }) }));
jest.mock("@/lib/page-chrome-context", () => ({ usePageChrome: () => ({ setLastSegmentLabel }) }));
jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));

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
  document.body.className = "";
});

it("shows the sale's items, payments, customer and prescription", async () => {
  mockApi(sale());
  render(<SaleDetailPage />);

  expect(await screen.findByRole("heading", { name: "INV-2610-000042" })).toBeInTheDocument();
  expect(apiJson).toHaveBeenCalledWith("/sales/history/sale-1");
  expect(setLastSegmentLabel).toHaveBeenCalledWith("INV-2610-000042");

  const details = screen.getByRole("region", { name: "Sale details" });
  expect(within(details).getByText("Partially refunded")).toBeInTheDocument();
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

it("explains a sale it can't show", async () => {
  mockApi(new Error("Sale not found"));
  render(<SaleDetailPage />);

  expect(await screen.findByText("Sale not found")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Back to sales history" })).toHaveAttribute("href", "/sales");
});
