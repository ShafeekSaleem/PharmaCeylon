/** @jest-environment jsdom */
import { describe, expect, it } from "@jest/globals";
import { render, screen } from "@testing-library/react";
import type { SupplierCashPayoutView } from "@pharmaceylon/shared";
import { CashPayoutDetail } from "./cash-payout-detail";

const mockApiJson = jest.fn();
jest.mock("@/lib/auth-client", () => ({ apiJson: (...args: unknown[]) => mockApiJson(...args) }));

jest.mock("../hooks/use-ledger", () => ({
  useInvoices: () => ({ rows: [{ id: "22222222-2222-4222-8222-222222222222", invoiceNumber: "INV-100", balance: "12500" }], fresh: true }),
}));

const payout: SupplierCashPayoutView = {
  id: "11111111-1111-4111-8111-111111111111",
  payoutNumber: "SCP-0042",
  status: "approved",
  supplier: { id: "s1", code: "HEM", name: "Hemas Pharmaceuticals" },
  purchaseOrder: null,
  amount: "12500.00",
  paidOn: "2026-11-14",
  reference: null,
  notes: null,
  allocations: [{ invoiceId: "22222222-2222-4222-8222-222222222222", amount: "12500.00" }],
  executionApprovalId: "33333333-3333-4333-8333-333333333333",
  approvalRevoked: false,
  readyAtCounter: true,
  approvalReview: null,
  approvalVersion: 1,
  requester: { id: "u1", fullName: "Kasun Jayasinghe" },
  requestedAt: "2026-11-14T10:00:00.000Z",
  approver: { id: "u2", fullName: "Dilini Fernando" },
  approvedAt: "2026-11-14T11:00:00.000Z",
  executor: null,
  executedAt: null,
  supplierPaymentId: null,
  cancelledBy: null,
  cancelledAt: null,
};

beforeEach(() => {
  mockApiJson.mockReset();
});

describe("CashPayoutDetail", () => {
  it("shows waiting at the counter for an approved payout", () => {
    render(
      <CashPayoutDetail
        payout={payout}
        branchName="Kollupitiya"
        invoiceNumbers={new Map([["22222222-2222-4222-8222-222222222222", "INV-100"]])}
        onChanged={() => undefined}
      />,
    );
    expect(screen.getByRole("button", { name: "Waiting at the counter" })).toBeTruthy();
    expect(screen.getByText(/Cash & shift/)).toBeTruthy();
    expect(screen.getByText("INV-100")).toBeTruthy();
  });
});