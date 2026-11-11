import { render, screen } from "@testing-library/react";
import SalesPage from "./page";
let mockKeys = ["sales.view", "returns.approve"];
let mockParams = new URLSearchParams();
jest.mock("next/navigation", () => ({ useSearchParams: () => mockParams }));
jest.mock("@/lib/permissions", () => ({ usePermissions: () => ({ permissionKeys: mockKeys, loading: false, hasLoadedOnce: true }) }));
jest.mock("./sales-history", () => ({ __esModule: true, default: () => <p>History content</p> }));
jest.mock("./components/pending-refund-approvals", () => ({ __esModule: true, default: () => <p>Module pending review</p> }));

beforeEach(() => { mockKeys = ["sales.view", "returns.approve"]; mockParams = new URLSearchParams(); });
it("keeps history and pending approvals within Sales", () => {
  const view = render(<SalesPage />);
  expect(screen.getByText("History content")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Pending approvals" })).toHaveAttribute("href", "/sales?view=pending-approvals");
  mockParams = new URLSearchParams("view=pending-approvals&request=refund-1");
  view.rerender(<SalesPage />);
  expect(screen.getByText("Module pending review")).toBeInTheDocument();
  expect(screen.queryByText("History content")).not.toBeInTheDocument();
});
it("defaults approver-only roles to the pending view without exposing history", () => {
  mockKeys = ["returns.approve"];
  render(<SalesPage />);
  expect(screen.queryByRole("link", { name: "Sales history" })).not.toBeInTheDocument();
  expect(screen.getByText("Module pending review")).toBeInTheDocument();
});
it("does not mount approval review for a history-only role even via deep link", () => {
  mockKeys = ["sales.view"];
  mockParams = new URLSearchParams("view=pending-approvals");
  render(<SalesPage />);
  expect(screen.getByText("History content")).toBeInTheDocument();
  expect(screen.queryByText("Module pending review")).not.toBeInTheDocument();
});
