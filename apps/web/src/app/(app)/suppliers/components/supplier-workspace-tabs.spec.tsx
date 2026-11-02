import { render, screen, waitFor } from "@testing-library/react";
import { SupplierMoneyTab } from "./supplier-workspace-tabs";
import { apiJson } from "@/lib/auth-client";

let branchId = "branch-a";
jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn(), apiFetch: jest.fn() }));
jest.mock("@/lib/use-auth", () => ({
  useAuth: () => ({ branchId, user: { id: "user-a", tenantId: "tenant-a" } }),
}));

const payment = {
  id: "payment-a",
  paymentNo: "PAY-A",
  supplier: { id: "supplier-a", code: "S", name: "Supplier" },
  paidOn: "2026-11-01",
  amount: "10.00",
  method: "bank_transfer",
  reference: "REF",
  notes: null,
  recordedBy: null,
  evidence: { id: "evidence-a", mediaType: "application/pdf" },
  voided: false,
  allocations: [],
};

function tab() {
  return (
    <SupplierMoneyTab
      supplierId="supplier-a"
      canInvoice
      canPay
      refreshKey={0}
      onPay={jest.fn()}
      onRecordInvoice={jest.fn()}
    />
  );
}

it("drops the previous branch's payments, and their evidence downloads, on a branch switch", async () => {
  (apiJson as jest.Mock).mockImplementation((path: string) =>
    Promise.resolve(branchId === "branch-a" && path.startsWith("/purchasing/payments") ? [payment] : []),
  );
  const view = render(tab());
  await waitFor(() => expect(screen.getByText("Download evidence")).toBeInTheDocument());
  (apiJson as jest.Mock).mockImplementation(() => new Promise(() => {}));
  branchId = "branch-b";
  view.rerender(tab());
  expect(screen.queryByText("Download evidence")).not.toBeInTheDocument();
  expect(screen.queryByText("PAY-A")).not.toBeInTheDocument();
});
