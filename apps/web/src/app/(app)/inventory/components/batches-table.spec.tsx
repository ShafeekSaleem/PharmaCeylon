import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BatchesTable } from "./batches-table";
import { apiJson } from "@/lib/auth-client";

jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));
jest.mock("@/components/role-access", () => ({
  RoleLink: () => null,
  RoleButton: () => null,
}));
const row = {
  id: "batch",
  productId: "product",
  batchNo: "B1",
  needsExpiryReview: true,
  isQuarantined: false,
  expiryDate: "2099-12-31",
  daysToExpiry: 10000,
  qtyOnHand: 10,
  costPrice: "1",
  sellingPrice: "2",
  product: { name: "Test product", sku: "P1" },
} as any;
it("confirms a flagged batch through the date form and refreshes inventory", async () => {
  (apiJson as jest.Mock).mockResolvedValue({});
  const onChanged = jest.fn();
  render(
    <BatchesTable
      rows={[row]}
      loading={false}
      page={1}
      canWrite
      onPageChange={() => {}}
      onAdjust={() => {}}
      onChanged={onChanged}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm expiry for batch B1" }),
  );
  fireEvent.change(screen.getByLabelText(/Actual expiry date/), {
    target: { value: "2027-06-30" },
  });
  // A plain string `name` is already matched in full, so this picks the dialog's own
  // "Confirm expiry" and not the row's "Confirm expiry for batch B1".
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
it("does not offer expiry mutation without inventory write access", () => {
  render(
    <BatchesTable
      rows={[row]}
      loading={false}
      page={1}
      canWrite={false}
      onPageChange={() => {}}
      onAdjust={() => {}}
    />,
  );
  expect(
    screen.queryByRole("button", { name: "Confirm expiry for batch B1" }),
  ).not.toBeInTheDocument();
});
