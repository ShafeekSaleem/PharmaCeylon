import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { apiJson } from "@/lib/auth-client";
import type { PreparedReceipt, PurchaseOrderDetail } from "../types";
import { PreparedReceiptPanel } from "./prepared-receipt-panel";

jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));

const order = {
  id: "po-1", poNumber: "PO-1", status: "issued",
  items: [{ id: "item", productId: "product", orderedQty: 10, receivedQty: 0, outstandingQty: 10, unitCost: "10.00",
    taxPercent: "0", product: { sku: "P1", name: "Product" } }],
} as unknown as PurchaseOrderDetail;
const review = { expectedVersion: 2, expectedDigest: "c".repeat(64) };
function receipt(overrides: Partial<PreparedReceipt> = {}): PreparedReceipt {
  return { id: "pr-1", purchaseOrderId: "po-1", status: "draft", orderOpen: true, notes: null, approvalVersion: 2,
    approvalReview: review, executionApprovalId: null, preparedBy: { id: "clerk", fullName: "Clerk" },
    preparedAt: "2026-10-28T00:00:00Z", approvedBy: null, approvedAt: null, executedBy: null, executedAt: null,
    goodsReceiptId: null, delivery: { supplierDeliveryNote: "DN-9", lines: [{ productId: "product", batchNo: "B9",
      expiryDate: "2028-01-01", receivedQty: 10, sellingPrice: "15.00" }] }, ...overrides } as PreparedReceipt;
}
const show = (row: PreparedReceipt, counterOnly: boolean) =>
  render(<PreparedReceiptPanel receipt={row} order={order} branchName="Main branch" canApprove canCancel canPost
    counterOnly={counterOnly} onChanged={jest.fn()} />);

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(apiJson).mockResolvedValue({});
  Object.defineProperty(crypto, "randomUUID", { configurable: true, value: () => "12345678-1234-4234-8234-123456789abc" });
});

it("approves the exact prepared delivery and never offers to post a draft", async () => {
  show(receipt(), false);
  expect(screen.queryByRole("button", { name: "Post receipt" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  fireEvent.click(screen.getByRole("button", { name: "Approve delivery" }));
  await waitFor(() => expect(apiJson).toHaveBeenCalledTimes(1));
  const [url, options] = jest.mocked(apiJson).mock.calls[0]!;
  expect(url).toBe("/purchasing/prepared-receipts/pr-1/approve");
  expect(JSON.parse(options!.body as string)).toEqual({ approvalId: "12345678-1234-4234-8234-123456789abc", ...review });
});

it("posts against the displayed approval where the branch still books goods in on the web", async () => {
  show(receipt({ status: "approved", executionApprovalId: "approval-7", approvalReview: review }), false);
  fireEvent.click(screen.getByRole("button", { name: "Post receipt" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Post receipt" }));
  await waitFor(() => expect(apiJson).toHaveBeenCalledTimes(1));
  const [url, options] = jest.mocked(apiJson).mock.calls[0]!;
  expect(url).toBe("/purchasing/prepared-receipts/pr-1/post");
  expect(JSON.parse(options!.body as string)).toEqual({ approvalId: "approval-7" });
});

it("hands an approved delivery to the counter at a live branch", () => {
  show(receipt({ status: "approved", executionApprovalId: "approval-7" }), true);
  expect(screen.queryByRole("button", { name: "Post receipt" })).toBeNull();
  expect(screen.getByText("Approved — waiting at the counter")).toBeInTheDocument();
});
