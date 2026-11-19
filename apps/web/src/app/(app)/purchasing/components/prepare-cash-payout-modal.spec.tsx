/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { apiJson } from "@/lib/auth-client";
import { PrepareCashPayoutModal } from "./prepare-cash-payout-modal";

jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));

jest.mock("../hooks/use-suppliers", () => ({
  useSuppliers: () => ({
    rows: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Hemas" }],
    loading: false,
  }),
}));

const invoiceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

jest.mock("../hooks/use-ledger", () => ({
  useInvoices: () => ({
    rows: [{ id: invoiceId, invoiceNumber: "INV-100", balance: "12500.00" }],
    fresh: true,
    error: null,
    loading: false,
  }),
}));

const mockApi = apiJson as jest.Mock;

beforeEach(() => {
  mockApi.mockReset();
});

describe("PrepareCashPayoutModal", () => {
  it("opens with the amount prompt from the spec", () => {
    render(<PrepareCashPayoutModal open onClose={() => undefined} onPrepared={() => undefined} />);
    expect(screen.getByText("Enter the amount to pay out")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Prepare cash payout/i })).toBeTruthy();
  });

  it("does not surface the self-approve note inside the modal", () => {
    render(<PrepareCashPayoutModal open onClose={() => undefined} onPrepared={() => undefined} />);
    expect(screen.queryByText(/self-approve supplier payments/i)).toBeNull();
  });

  it("submits supplier, amount and allocations then closes", async () => {
    mockApi.mockResolvedValueOnce({ status: "prepared" });
    const onClose = jest.fn();
    const onPrepared = jest.fn();
    render(<PrepareCashPayoutModal open onClose={onClose} onPrepared={onPrepared} />);
    fireEvent.click(screen.getByLabelText("Supplier"));
    fireEvent.click(screen.getByRole("option", { name: /Hemas/ }));
    fireEvent.change(screen.getByLabelText("Amount (LKR)"), { target: { value: "12500" } });
    fireEvent.change(screen.getByLabelText("Allocate to INV-100"), { target: { value: "12500" } });
    fireEvent.click(screen.getByRole("button", { name: /Prepare cash payout/i }));
    await waitFor(() => expect(mockApi).toHaveBeenCalledTimes(1));
    expect(mockApi).toHaveBeenCalledWith("/purchasing/cash-payouts", {
      method: "POST",
      body: expect.any(String),
    });
    const body = JSON.parse(String(mockApi.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      supplierId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      amount: "12500.00",
      allocations: [{ invoiceId, amount: "12500.00" }],
    });
    await waitFor(() => expect(onPrepared).toHaveBeenCalled());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("keeps the modal open and shows an error when the API rejects", async () => {
    mockApi.mockRejectedValueOnce(new Error("Supplier ledger is locked"));
    const onClose = jest.fn();
    render(<PrepareCashPayoutModal open onClose={onClose} onPrepared={() => undefined} />);
    fireEvent.click(screen.getByLabelText("Supplier"));
    fireEvent.click(screen.getByRole("option", { name: /Hemas/ }));
    fireEvent.change(screen.getByLabelText("Amount (LKR)"), { target: { value: "500.00" } });
    fireEvent.change(screen.getByLabelText("Allocate to INV-100"), { target: { value: "500.00" } });
    const submit = screen.getByRole("button", { name: /Prepare cash payout/i });
    expect(submit.hasAttribute("disabled")).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(mockApi).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText(/Supplier ledger is locked/)).toBeTruthy());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Prepare cash payout/i })).toBeTruthy();
  });
});