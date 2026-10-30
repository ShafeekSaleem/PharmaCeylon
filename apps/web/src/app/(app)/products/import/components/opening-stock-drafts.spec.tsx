import { fireEvent, render, screen } from "@testing-library/react";
import { apiJson } from "@/lib/auth-client";
import { OpeningStockDrafts } from "./opening-stock-drafts";
let branchId = "branch-a";
let permissionKeys = ["products.import", "costs.view"];
jest.mock("@/lib/use-auth", () => ({ useAuth: () => ({ branchId }) }));
jest.mock("@/lib/permissions", () => ({
  usePermissions: () => ({ permissionKeys }),
}));
jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));
const api = apiJson as jest.Mock;
beforeEach(() => {
  branchId = "branch-a";
  permissionKeys = ["products.import", "costs.view"];
  api.mockReset();
});
it("only offers completed staged drafts at the selected branch", async () => {
  api.mockResolvedValue([
    {
      id: "a",
      filename: "Current.csv",
      branchId: "branch-a",
      stockStaged: true,
      status: "completed",
      unitsStaged: 10,
    },
    {
      id: "b",
      filename: "Other.csv",
      branchId: "branch-b",
      stockStaged: true,
      status: "completed",
      unitsStaged: 20,
    },
    {
      id: "c",
      filename: "Running.csv",
      branchId: "branch-a",
      stockStaged: true,
      status: "running",
    },
    {
      id: "d",
      filename: "Legacy.csv",
      branchId: "branch-a",
      stockStaged: false,
      status: "completed",
    },
  ]);
  render(<OpeningStockDrafts />);
  expect(
    await screen.findByRole("button", {
      name: "Current.csv — 10 units waiting",
    }),
  ).toBeInTheDocument();
  expect(
    screen.queryByText(/Other.csv|Running.csv|Legacy.csv/),
  ).not.toBeInTheDocument();
  expect(api).toHaveBeenCalledWith("/products/import/history?take=50", {
    headers: { "x-branch-id": "branch-a" },
  });
  api.mockResolvedValue({
    importId: "a",
    version: 1,
    rows: [],
    postedAt: null,
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Current.csv — 10 units waiting" }),
  );
  await screen.findByText(/Version 1/);
  expect(api).toHaveBeenLastCalledWith("/products/import/a/stock", {
    headers: { "x-branch-id": "branch-a" },
  });
});
it("does not fetch import data without import permission", () => {
  permissionKeys = [];
  render(<OpeningStockDrafts />);
  expect(api).not.toHaveBeenCalled();
  expect(screen.queryByText("Opening-stock drafts")).not.toBeInTheDocument();
});
it("drops the selected draft when the branch changes", async () => {
  api.mockResolvedValue([
    {
      id: "a",
      filename: "Current.csv",
      branchId: "branch-a",
      stockStaged: true,
      status: "completed",
      unitsStaged: 10,
    },
  ]);
  const { rerender } = render(<OpeningStockDrafts />);
  await screen.findByRole("button", { name: "Current.csv — 10 units waiting" });
  api.mockResolvedValue([]);
  branchId = "branch-b";
  rerender(<OpeningStockDrafts />);
  expect(
    await screen.findByText(/No completed opening-stock drafts/),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /Current.csv/ }),
  ).not.toBeInTheDocument();
});
