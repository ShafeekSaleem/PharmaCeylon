import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { pickDate } from "@/test-utils/pick-date";
import { BatchesTable } from "./batches-table";
import { apiJson } from "@/lib/auth-client";

jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));

const everything = {
  canAdjustIn: true,
  canWriteOff: true,
  canQuarantine: true,
  canRelease: true,
  canViewCost: true,
};
const nothing = {
  canAdjustIn: false,
  canWriteOff: false,
  canQuarantine: false,
  canRelease: false,
  canViewCost: false,
};

function batch(overrides: Record<string, unknown> = {}) {
  return {
    id: "batch",
    productId: "product",
    batchNo: "B1",
    needsExpiryReview: false,
    isQuarantined: false,
    quarantineReason: null,
    expiryDate: "2099-12-31",
    daysToExpiry: 10000,
    expired: false,
    nearExpiry: false,
    qtyOnHand: 10,
    quarantinedQty: 0,
    reservedQty: 0,
    availableQty: 10,
    costPrice: "1",
    sellingPrice: "2",
    supplier: null,
    product: { name: "Test product", sku: "P1" },
    ...overrides,
  } as any;
}

function renderTable(rows: any[], access = everything, onChanged = jest.fn()) {
  render(
    <BatchesTable
      rows={rows}
      loading={false}
      page={1}
      access={access}
      onPageChange={() => {}}
      onAdjust={() => {}}
      onChanged={onChanged}
    />,
  );
  return onChanged;
}

function openMenu(batchNo = "B1") {
  fireEvent.click(screen.getByRole("button", { name: `Actions for batch ${batchNo}` }));
  return screen.getByRole("menu");
}

beforeEach(() => {
  (apiJson as jest.Mock).mockReset();
  (apiJson as jest.Mock).mockResolvedValue({});
});

it("confirms a flagged batch's expiry through the row menu and refreshes inventory", async () => {
  const onChanged = renderTable([batch({ needsExpiryReview: true })]);
  fireEvent.click(within(openMenu()).getByRole("menuitem", { name: "Confirm expiry date" }));
  pickDate(/Actual expiry date/, "2027-06-30");
  fireEvent.click(screen.getByRole("button", { name: "Confirm expiry" }));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  expect(apiJson).toHaveBeenCalledWith(
    "/inventory/batches/batch/confirm-expiry",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ expiryDate: "2027-06-30" }),
    }),
  );
});

it("offers no stock-changing actions without the matching permissions", () => {
  renderTable([batch({ needsExpiryReview: true, quarantinedQty: 2 })], nothing);
  const menu = openMenu();
  expect(within(menu).queryByRole("menuitem", { name: "Confirm expiry date" })).not.toBeInTheDocument();
  expect(within(menu).queryByRole("menuitem", { name: "Quarantine units" })).not.toBeInTheDocument();
  expect(within(menu).queryByRole("menuitem", { name: "Release from quarantine" })).not.toBeInTheDocument();
  expect(within(menu).queryByRole("menuitem", { name: "Adjust stock" })).not.toBeInTheDocument();
});

it("opens a counter-only quarantine handoff instead of calling the browser quarantine route", () => {
  renderTable([batch({ reservedQty: 3, availableQty: 7 })]);
  fireEvent.click(within(openMenu()).getByRole("menuitem", { name: "Quarantine units" }));

  expect(screen.getByRole("status")).toHaveTextContent("Do this at the counter in PharmaCeylon POS.");
  expect(screen.getByRole("status")).toHaveTextContent("Quarantine the stock at this branch.");
  expect(screen.queryByRole("button", { name: "Quarantine" })).not.toBeInTheDocument();
  expect(apiJson).not.toHaveBeenCalled();
});

it("does not offer to release quarantined units once the batch has expired", () => {
  renderTable([batch({ expired: true, daysToExpiry: -3, quarantinedQty: 4, availableQty: 0 })]);
  const release = within(openMenu()).getByRole("menuitem", { name: /Release from quarantine/ });
  expect(release).toBeDisabled();
});

it("shows cost only to people who may see it", () => {
  const { unmount } = render(
    <BatchesTable
      rows={[batch()]}
      loading={false}
      page={1}
      access={{ ...everything, canViewCost: false }}
      onPageChange={() => {}}
      onAdjust={() => {}}
    />,
  );
  expect(screen.getByRole("columnheader", { name: "Selling price" })).toBeInTheDocument();
  expect(screen.queryByRole("columnheader", { name: /Cost/ })).not.toBeInTheDocument();
  unmount();

  renderTable([batch()]);
  expect(screen.getByRole("columnheader", { name: /Cost → Sell/ })).toBeInTheDocument();
});

it("separates available from on hand and shows held units", () => {
  renderTable([batch({ quarantinedQty: 2, reservedQty: 3, availableQty: 5 })]);
  expect(screen.getByText("of 10 units on hand")).toBeInTheDocument();
  expect(screen.getByText("2 quarantined")).toBeInTheDocument();
  expect(screen.getByText("3 reserved")).toBeInTheDocument();
});
