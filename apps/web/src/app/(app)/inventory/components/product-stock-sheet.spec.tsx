import { render, screen, within } from "@testing-library/react";
import { ProductStockSheet } from "./product-stock-sheet";
import { useProductStock } from "../hooks/use-product-stock";

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));
jest.mock("../hooks/use-product-stock", () => ({ useProductStock: jest.fn() }));

const access = {
  ready: true,
  canAdjustIn: true,
  canWriteOff: true,
  canQuarantine: true,
  canRelease: true,
  canQuarantineAllExpired: true,
  canViewCost: false,
};

const detail = {
  product: {
    id: "p1",
    sku: "PCL-1",
    name: "Paracetamol 500mg",
    genericName: null,
    brandName: null,
    strength: "500mg",
    dosageForm: "Tablet",
    unit: null,
    imageUrl: null,
    reorderLevel: 20,
    isControlled: false,
    isActive: true,
    rangeStatus: "RANGED",
  },
  stockStatus: "ok",
  totals: { onHand: 100, available: 80, quarantined: 5, reserved: 15, expired: 0, incoming: 12, onOrder: 50 },
  batches: [
    {
      id: "b1",
      batchNo: "LOT-1",
      expiryDate: "2027-01-01",
      receivedAt: "2026-01-01",
      costPrice: null,
      sellingPrice: "15.00",
      productId: "p1",
      qtyOnHand: 100,
      quarantinedQty: 5,
      reservedQty: 15,
      availableQty: 80,
      daysToExpiry: 100,
      expired: false,
      nearExpiry: false,
      isQuarantined: false,
      quarantinedAt: null,
      quarantineReason: "Damaged",
      needsExpiryReview: false,
      supplier: null,
      product: { id: "p1", sku: "PCL-1", name: "Paracetamol 500mg", reorderLevel: 20, isControlled: false, unit: null, imageUrl: null },
    },
  ],
  reservations: [
    { qty: 15, batchNo: "LOT-1", sourceType: "transfer", sourceId: "t1", label: "TR-00007 to Galle", createdAt: "2026-09-01" },
  ],
  incoming: [
    { transferId: "t2", transferNumber: "TR-00009", fromBranch: { id: "b2", name: "Negombo" }, qty: 12, expectedOn: null },
  ],
  onOrder: [
    { purchaseOrderId: "po1", poNumber: "PO-00031", supplier: { id: "s1", name: "Hemas" }, qty: 50, expectedOn: null },
  ],
  otherBranches: [{ branchId: "b3", name: "Galle", code: "GALLE", onHand: 40, available: 38 }],
  recentMovements: [
    {
      id: "m1",
      occurredAt: "2026-09-15T08:00:00Z",
      movementType: "quarantine_hold",
      referenceType: "batch_quarantine",
      referenceId: "r1",
      reason: "Damaged",
      reasonCode: "damaged",
      batchId: "b1",
      batchNo: "LOT-1",
      qtyDelta: 0,
      quarantineDelta: 5,
      balanceBefore: null,
      balanceAfter: null,
      actorId: "u1",
      actorName: "Clerk",
      product: { id: "p1", sku: "PCL-1", name: "Paracetamol 500mg" },
    },
  ],
};

function renderSheet(overrides = {}) {
  (useProductStock as jest.Mock).mockReturnValue({
    detail,
    loading: false,
    error: null,
    reload: jest.fn(),
    ...overrides,
  });
  render(
    <ProductStockSheet
      productId="p1"
      access={access}
      onClose={() => {}}
      onAdjust={() => {}}
      onChanged={() => {}}
    />,
  );
}

it("shows where the units are: available, on hand, held, promised and on the way", () => {
  renderSheet();
  const totals = screen.getByRole("group", { name: "Stock totals" });
  for (const [label, value] of [
    ["Available", "80"],
    ["On hand", "100"],
    ["Quarantined", "5"],
    ["Reserved", "15"],
    ["Incoming", "12"],
    ["On order", "50"],
  ]) {
    const tile = within(totals).getByText(label).parentElement!;
    expect(within(tile).getByText(value)).toBeInTheDocument();
  }
});

it("names the documents holding or bringing stock, and other branches' stock", () => {
  renderSheet();
  expect(screen.getByRole("link", { name: "TR-00007 to Galle" })).toHaveAttribute("href", "/transfers?transfer=t1");
  expect(screen.getByRole("link", { name: "TR-00009" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "PO-00031" })).toHaveAttribute("href", "/purchasing?po=po1");
  expect(screen.getByText("38 available")).toBeInTheDocument();
});

it("shows a quarantine move as held units rather than a change to on hand", () => {
  renderSheet();
  expect(screen.getByText("+5 held")).toBeInTheDocument();
});

it("keeps cost off the sheet without the cost permission", () => {
  renderSheet();
  expect(screen.queryByText(/cost LKR/)).not.toBeInTheDocument();
});

it("offers a retry when the stock can't be loaded", () => {
  renderSheet({ detail: null, error: "Network down" });
  expect(screen.getByText("Network down")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
});
