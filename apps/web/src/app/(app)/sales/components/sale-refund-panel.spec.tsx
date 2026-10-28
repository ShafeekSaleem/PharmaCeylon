import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { apiJson } from "@/lib/auth-client";
import { usePermissions } from "@/lib/permissions";
import { useAuth } from "@/lib/use-auth";
import type { SaleDetail, SaleRefundRequest } from "../types";
import { SaleRefundPanel } from "./sale-refund-panel";

jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));
jest.mock("@/lib/use-auth", () => ({ useAuth: jest.fn() }));
jest.mock("@/lib/permissions", () => ({ usePermissions: jest.fn() }));

const sale = {
  id: "sale-1",
  invoiceNo: "INV-1",
  status: "posted",
  branch: { id: "branch-a", name: "Colombo" },
  items: [
    {
      id: "item-1",
      qty: 4,
      product: { id: "p-1", name: "Amoxicillin", sku: "AMX" },
      batch: { id: "b-1", batchNo: "B-1", expiryDate: "2027-01-01" },
    },
  ],
} as unknown as SaleDetail;

function request(overrides: Partial<SaleRefundRequest> = {}): SaleRefundRequest {
  return {
    id: "rr-1",
    requestNumber: "RFR-00001",
    saleId: "sale-1",
    invoiceNo: "INV-1",
    status: "prepared",
    lines: [{ productId: "p-1", batchId: "b-1", qty: 2, unitPrice: "100.00", disposition: "restock" }],
    amount: "200.00",
    refundMethod: null,
    reasonCode: "damaged",
    reason: "Damaged",
    approvalRequired: true,
    executionApprovalId: null,
    approvalRevoked: false,
    readyAtCounter: false,
    approvalReview: { expectedVersion: 1, expectedDigest: "b".repeat(64) },
    approvalVersion: 1,
    requester: { id: "user-clerk", fullName: "Clerk" },
    requestedAt: "2026-10-28T04:00:00.000Z",
    approver: null,
    approvedAt: null,
    executor: null,
    executedAt: null,
    goodsReturnId: null,
    cancelledBy: null,
    cancelledAt: null,
    ...overrides,
  };
}

function setup(keys: string[], rows: SaleRefundRequest[], branchId = "branch-a") {
  jest.mocked(useAuth).mockReturnValue({ branchId, user: { id: "user-manager" } } as never);
  jest.mocked(usePermissions).mockReturnValue({ permissionKeys: keys, canSelfApprove: true } as never);
  jest.mocked(apiJson).mockImplementation(async (path: string) => (path.startsWith("/sales/refund-requests?") ? rows : {}) as never);
  render(<SaleRefundPanel sale={sale} />);
}

beforeEach(() => {
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    configurable: true,
    value: () => "12345678-1234-4234-8234-123456789abc",
  });
});

describe("SaleRefundPanel", () => {
  it("prepares a refund that waits at the counter, with no execute button", async () => {
    setup(["sales.refund"], []);
    fireEvent.click(await screen.findByRole("button", { name: "Prepare a refund" }));
    fireEvent.change(screen.getByLabelText("Units of Amoxicillin coming back"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare refund" }));
    await waitFor(() =>
      expect(apiJson).toHaveBeenCalledWith("/sales/sale-1/refund-requests", expect.objectContaining({ method: "POST" })),
    );
    const call = jest.mocked(apiJson).mock.calls.find(([path]) => path === "/sales/sale-1/refund-requests")!;
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({
      items: [{ productId: "p-1", batchId: "b-1", qty: 2 }],
      reasonCode: "damaged",
    });
    expect(screen.queryByRole("button", { name: /refund now|execute/i })).toBeNull();
  });

  it("approves the exact prepared content over the threshold", async () => {
    setup(["sales.refund", "returns.approve"], [request()]);
    fireEvent.click(await screen.findByRole("button", { name: "Approve refund" }));
    await waitFor(() =>
      expect(apiJson).toHaveBeenCalledWith("/sales/refund-requests/rr-1/approve", expect.anything()),
    );
    const call = jest.mocked(apiJson).mock.calls.find(([path]) => path === "/sales/refund-requests/rr-1/approve")!;
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({
      approvalId: "12345678-1234-4234-8234-123456789abc",
      expectedVersion: 1,
      expectedDigest: "b".repeat(64),
    });
  });

  it("shows an approved refund waiting at the counter", async () => {
    setup(["sales.refund"], [request({ status: "approved", readyAtCounter: true, executionApprovalId: "ap-1",
      approver: { id: "user-owner", fullName: "Owner" }, approvedAt: "2026-10-28T05:00:00.000Z" })]);
    expect(await screen.findByText("Approved — waiting at the counter")).toBeTruthy();
    expect(screen.getByText(/Refund the customer/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve refund" })).toBeNull();
  });

  it("asks to switch branch for another branch's sale", () => {
    setup(["sales.refund"], [], "branch-b");
    expect(screen.getByText(/Switch the active branch to/)).toBeTruthy();
    expect(apiJson).not.toHaveBeenCalled();
  });
});
