import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RecordPaymentModal } from "./record-payment-modal";
import { apiJson } from "@/lib/auth-client";
import { ApiError } from "@/lib/api-error";
let branch = "branch-a";
let rollout: string | null = "live";
const invoice = {
  id: "invoice-a",
  invoiceNumber: "INV-1",
  balance: "100.00",
  dueDate: "2026-01-01",
  invoiceDate: "2026-01-01",
  supplier: { id: "supplier-a" },
};
jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));
jest.mock("@/lib/use-auth", () => ({
  useAuth: () => ({
    branchId: branch,
    user: { id: "user-a", tenantId: "tenant-a" },
  }),
}));
jest.mock("@/lib/branch-rollout", () => ({
  useBranchRollout: () => ({ rollout: rollout ? { state: rollout } : null }),
}));
jest.mock("../hooks/use-ledger", () => ({
  useInvoices: () => ({ rows: [invoice], loading: false, error: null }),
}));
jest.mock("../hooks/use-suppliers", () => ({
  useSuppliers: () => ({
    rows: [{ id: "supplier-a", name: "Supplier" }],
    loading: false,
  }),
}));
jest.mock("./purchasing-select", () => ({
  PurchasingSelect: ({ label, value, options, onChange, disabled }: any) => (
    <label>
      {label}
      <select
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o: any) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  ),
}));
jest.mock("@/components/ui", () => ({
  Modal: ({ open, children, footer }: any) =>
    open ? (
      <div>
        {children}
        {footer}
      </div>
    ) : null,
  ModalFooter: ({ children }: any) => <div>{children}</div>,
  ModalButton: ({ children, loading, ...props }: any) => (
    <button {...props}>{children}</button>
  ),
  DatePicker: ({ label, onChange, ...props }: any) => (
    <input
      aria-label={label}
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
  SegmentedTabs: () => null,
}));
const mockApi = apiJson as jest.Mock;
function setup() {
  const recorded = jest.fn();
  const view = render(
    <RecordPaymentModal
      open
      onClose={jest.fn()}
      onRecorded={recorded}
      preset={{ supplierId: "supplier-a" }}
    />,
  );
  fireEvent.change(screen.getByLabelText("Amount paid"), {
    target: { value: "50.00" },
  });
  fireEvent.change(screen.getByLabelText("Reference"), {
    target: { value: "BANK-1" },
  });
  fireEvent.change(screen.getByLabelText("Supporting document"), {
    target: {
      files: [new File(["pdf"], "receipt.pdf", { type: "application/pdf" })],
    },
  });
  return { ...view, recorded };
}
beforeEach(() => {
  sessionStorage.clear();
  branch = "branch-a";
  rollout = "live";
  mockApi.mockReset();
  Object.defineProperty(crypto, "randomUUID", {
    configurable: true,
    value: () => "evidence-a",
  });
});
it("reviews exact allocations then uploads privately and records with the same binding", async () => {
  mockApi
    .mockResolvedValueOnce({ id: "evidence-a" })
    .mockResolvedValueOnce({ id: "payment-a" });
  const { recorded } = setup();
  fireEvent.click(screen.getByText("Review payment"));
  expect(mockApi).not.toHaveBeenCalled();
  expect(
    screen.getByLabelText("Reviewed invoice allocations"),
  ).toHaveTextContent("INV-1");
  fireEvent.click(screen.getByText("Record payment"));
  await waitFor(() =>
    expect(recorded).toHaveBeenCalledWith({ id: "payment-a" }),
  );
  const upload = mockApi.mock.calls[0];
  const record = mockApi.mock.calls[1];
  expect(upload[0]).toBe("/purchasing/payment-evidence");
  expect(record[0]).toBe("/purchasing/payments/evidenced");
  expect(JSON.parse(upload[1].body.get("payment"))).toEqual(
    JSON.parse(record[1].body).payment,
  );
  expect(JSON.parse(record[1].body).payment.allocations).toEqual([
    { invoiceId: "invoice-a", amount: "50.00" },
  ]);
});
it("replays an uncertain payment after remount without another upload", async () => {
  mockApi
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(new Error("Lost response"));
  const first = setup();
  fireEvent.click(screen.getByText("Review payment"));
  fireEvent.click(screen.getByText("Record payment"));
  await screen.findByText(/Lost response/);
  const original = mockApi.mock.calls[1][1];
  expect(screen.getByLabelText("Amount paid")).toBeDisabled();
  first.unmount();
  mockApi.mockResolvedValueOnce({ id: "payment-a" });
  const recorded = jest.fn();
  render(<RecordPaymentModal open onClose={jest.fn()} onRecorded={recorded} />);
  fireEvent.click(screen.getByText("Retry same payment"));
  await waitFor(() => expect(recorded).toHaveBeenCalled());
  expect(mockApi.mock.calls[2][1]).toEqual(original);
});
it("allows revocation and editing after a definite refusal", async () => {
  mockApi
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(new ApiError("Invalid", 400, {}));
  setup();
  fireEvent.click(screen.getByText("Review payment"));
  fireEvent.click(screen.getByText("Record payment"));
  await screen.findByText(/Invalid/);
  mockApi.mockResolvedValueOnce({});
  fireEvent.click(screen.getByText("Discard unused evidence and edit"));
  await waitFor(() =>
    expect(screen.getByLabelText("Amount paid")).not.toBeDisabled(),
  );
  expect(mockApi.mock.calls[2][0]).toBe(
    "/purchasing/payment-evidence/evidence-a/revoke",
  );
});
it.each(["live", "fallback", null])(
  "blocks cash when rollout is %s",
  (state) => {
    rollout = state;
    setup();
    fireEvent.change(screen.getByLabelText("Paid by"), {
      target: { value: "cash" },
    });
    expect(screen.getByText("Record payment")).toBeDisabled();
  },
);
it("preserves legacy cash at known not-live branches", async () => {
  rollout = "not_live";
  mockApi.mockResolvedValue({ id: "payment-a" });
  setup();
  fireEvent.change(screen.getByLabelText("Paid by"), {
    target: { value: "cash" },
  });
  fireEvent.click(screen.getByText("Record payment"));
  await waitFor(() =>
    expect(mockApi).toHaveBeenCalledWith(
      "/purchasing/payments",
      expect.anything(),
    ),
  );
});

it("keeps reviewed allocations when the invoice data refreshes", async () => {
  mockApi.mockResolvedValueOnce({}).mockResolvedValueOnce({ id: "payment-a" });
  const view = setup();
  fireEvent.click(screen.getByText("Review payment"));
  invoice.balance = "10.00";
  view.rerender(
    <RecordPaymentModal open onClose={jest.fn()} onRecorded={view.recorded} />,
  );
  fireEvent.click(screen.getByText("Record payment"));
  await waitFor(() => expect(view.recorded).toHaveBeenCalled());
  expect(JSON.parse(mockApi.mock.calls[1][1].body).payment.allocations).toEqual(
    [{ invoiceId: "invoice-a", amount: "50.00" }],
  );
  invoice.balance = "100.00";
});
it("does not record or replace UI state after switching branch during upload", async () => {
  let finish!: (value: unknown) => void;
  mockApi.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = setup();
  fireEvent.click(screen.getByText("Review payment"));
  fireEvent.click(screen.getByText("Record payment"));
  await waitFor(() => expect(mockApi).toHaveBeenCalledTimes(1));
  branch = "branch-b";
  view.rerender(
    <RecordPaymentModal open onClose={jest.fn()} onRecorded={view.recorded} />,
  );
  finish({});
  await waitFor(() =>
    expect(screen.getByLabelText("Amount paid")).not.toBeDisabled(),
  );
  expect(mockApi).toHaveBeenCalledTimes(1);
  expect(view.recorded).not.toHaveBeenCalled();
});
