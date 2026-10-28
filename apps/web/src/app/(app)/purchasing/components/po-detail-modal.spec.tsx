import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PoDetailModal } from "./po-detail-modal";
import { usePurchaseOrderDetail } from "../hooks/use-purchase-orders";
import { apiJson } from "@/lib/auth-client";
import type { HeldDelivery, PurchaseOrderDetail } from "../types";

jest.mock("../hooks/use-purchase-orders", () => ({ usePurchaseOrderDetail: jest.fn() }));
jest.mock("../hooks/use-batch-lookup", () => ({ useBatchLookup: () => ({ results: {}, lookup: jest.fn() }) }));
jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));
jest.mock("@/lib/branch-rollout", () => ({
  useBranchRollout: () => ({ rollout: { state: "not_live", liveSince: null, fallback: null }, loading: false, resolved: true, failed: false }),
}));

const reload = jest.fn();
function order(id: string, cost: string | null, updateSupplierPrice = false): PurchaseOrderDetail {
  const delivery = { id: `held-${id}`, status: "awaiting_approval", reasons: ["over_delivery"],
    requestedAt: "2026-10-26T00:00:00Z", requester: { fullName: "Receiver" },
    approvalReview: { expectedVersion: 3, expectedDigest: "a".repeat(64) },
    delivery: { purchaseOrderId: id, receivedOn: "2026-10-26", supplierDeliveryNote: "DN-123",
      updateSupplierPrice, lines: [{ productId: "product", batchNo: "B1", expiryDate: "2028-01-01",
        receivedQty: 2, ...(cost ? { costPrice: cost } : {}), sellingPrice: "20.00" }] },
  } as unknown as HeldDelivery;
  return { id, poNumber: id, status: "issued", createdAt: "2026-10-25", expectedOn: null,
    supplier: { name: "Supplier", code: "S1" }, goodsReceipts: [], heldDeliveries: [delivery],
    items: [{ id: `item-${id}`, productId: "product", orderedQty: 1, receivedQty: 0, unitCost: cost ? "10.00" : null,
      taxPercent: "0", product: { sku: "P1", name: "Product" } }],
  } as unknown as PurchaseOrderDetail;
}
const props = { canWrite: false, canReceiveGoods: false, canCancelPo: false, canApprovePo: true,
  onClose: jest.fn(), onChanged: jest.fn() };
function show(detail: PurchaseOrderDetail) {
  jest.mocked(usePurchaseOrderDetail).mockReturnValue({ detail, loading: false, error: null, reload } as never);
  jest.mocked(apiJson).mockResolvedValue(detail.heldDeliveries![0]);
}
beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(crypto, "randomUUID", { configurable: true, value: () => "12345678-1234-4234-8234-123456789abc" });
});

it("approves the exact saved delivery without rebuilding redacted costs or the supplier reference", async () => {
  show(order("one", null));
  render(<PoDetailModal {...props} poId="one" reviewHeldId="held-one" />);
  fireEvent.click(await screen.findByRole("button", { name: "Approve unchanged" }));
  expect(screen.getAllByText(/Note DN-123/).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "Approve delivery" }));
  await waitFor(() => expect(apiJson).toHaveBeenCalledTimes(1));
  const [url, options] = jest.mocked(apiJson).mock.calls[0];
  expect(url).toBe("/purchasing/held-deliveries/held-one/accept");
  expect(options?.method).toBe("POST");
  expect(JSON.parse(options!.body as string)).toEqual({ approvalId: expect.any(String),
    expectedVersion: 3, expectedDigest: "a".repeat(64) });
});

it("hydrates each delivery's supplier-price choice and never carries it into another order", async () => {
  show(order("one", "12.00", true));
  const view = render(<PoDetailModal {...props} poId="one" reviewHeldId="held-one" />);
  expect(await screen.findByRole("checkbox", { name: /supplier/i })).toBeChecked();
  show(order("two", "10.00"));
  view.rerender(<PoDetailModal {...props} poId="two" reviewHeldId="held-two" />);
  fireEvent.click(await screen.findByRole("button", { name: "Save corrections and review approval" }));
  await waitFor(() => expect(apiJson).toHaveBeenCalledTimes(1));
  const [url, options] = jest.mocked(apiJson).mock.calls[0];
  expect(url).toBe("/purchasing/held-deliveries/held-two");
  expect(options?.method).toBe("PATCH");
  const body = JSON.parse(options!.body as string);
  expect(body).not.toHaveProperty("updateSupplierPrice");
  expect(body.delivery.lines[0]).not.toHaveProperty("costPrice");
});

it("omits redacted costs when a reviewer saves quantity corrections", async () => {
  show(order("one", null));
  render(<PoDetailModal {...props} poId="one" reviewHeldId="held-one" />);
  const save = await screen.findByRole("button", { name: "Save corrections and review approval" });
  expect(save).toBeEnabled();
  fireEvent.click(save);
  await waitFor(() => expect(apiJson).toHaveBeenCalledTimes(1));
  const body = JSON.parse(jest.mocked(apiJson).mock.calls[0][1]!.body as string);
  expect(body.delivery.lines[0]).not.toHaveProperty("costPrice");
  expect(body.delivery.lines[0]).not.toHaveProperty("packCost");
});

it("saves an explicit supplier-price change only for the current delivery", async () => {
  show(order("one", "12.00", true));
  render(<PoDetailModal {...props} poId="one" reviewHeldId="held-one" />);
  fireEvent.click(await screen.findByRole("checkbox", { name: /supplier/i }));
  fireEvent.click(screen.getByRole("button", { name: "Save corrections and review approval" }));
  await waitFor(() => expect(apiJson).toHaveBeenCalledTimes(1));
  const body = JSON.parse(jest.mocked(apiJson).mock.calls[0][1]!.body as string);
  expect(body.updateSupplierPrice).toBe(false);
});
