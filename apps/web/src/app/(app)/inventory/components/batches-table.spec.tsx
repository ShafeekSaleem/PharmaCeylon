import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  fireEvent.change(screen.getByLabelText(/Actual expiry date/), {
    target: { value: "2027-06-30" },
  });
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

it("quarantines part of a batch with a reason code", async () => {
  // 10 on hand, 3 reserved for a transfer: only 7 can be held.
  const onChanged = renderTable([batch({ reservedQty: 3, availableQty: 7 })]);
  fireEvent.click(within(openMenu()).getByRole("menuitem", { name: "Quarantine units" }));

  const qty = screen.getByLabelText(/Units to quarantine/) as HTMLInputElement;
  expect(qty.value).toBe("7");
  fireEvent.change(qty, { target: { value: "2" } });
  fireEvent.click(screen.getByRole("button", { name: "Quarantine" }));

  await waitFor(() => expect(onChanged).toHaveBeenCalledWith("Quarantined 2 units of batch B1."));
  expect(apiJson).toHaveBeenCalledWith(
    "/inventory/batches/batch/quarantine",
    expect.objectContaining({
      body: JSON.stringify({ qty: 2, reasonCode: "damaged" }),
    }),
  );
});

it("won't quarantine more than can be held", () => {
  renderTable([batch()]);
  fireEvent.click(within(openMenu()).getByRole("menuitem", { name: "Quarantine units" }));
  fireEvent.change(screen.getByLabelText(/Units to quarantine/), { target: { value: "11" } });
  expect(screen.getByText("Enter a whole number from 1 to 10")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Quarantine" })).toBeDisabled();
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
