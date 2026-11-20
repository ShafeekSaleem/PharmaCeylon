import { render, screen } from "@testing-library/react";
import SalesPage from "./page";
let mockKeys = ["sales.view", "returns.approve", "tenant.management"];
let mockParams = new URLSearchParams();
jest.mock("next/navigation", () => ({ useSearchParams: () => mockParams }));
jest.mock("@/lib/permissions", () => ({ usePermissions: () => ({ permissionKeys: mockKeys, loading: false, hasLoadedOnce: true }) }));
jest.mock("@/lib/use-auth", () => ({ useAuth: () => ({ branchId: "branch-a" }) }));
jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn().mockResolvedValue({ total: 0, items: [] }) }));
jest.mock("./sales-history", () => ({ __esModule: true, default: () => <p>History content</p> }));
jest.mock("./components/pending-refund-approvals", () => ({ __esModule: true, default: () => <p>Module pending review</p> }));
jest.mock("./components/sales-incident-notes", () => ({ __esModule: true, default: () => <p>Incident queue</p> }));
jest.mock("./components/sales-payment-recovery", () => ({ __esModule: true, default: () => <p>Payment queue</p> }));
jest.mock("./components/sales-collected-money", () => ({ __esModule: true, default: () => <p>Money queue</p> }));

beforeEach(() => {
  mockKeys = ["sales.view", "returns.approve", "tenant.management"];
  mockParams = new URLSearchParams();
});
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

it("hides recovery queue tabs without tenant.management", () => {
  mockKeys = ["sales.view", "returns.approve"];
  render(<SalesPage />);
  expect(screen.queryByRole("link", { name: /Incident notes/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /Payment recovery/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /Unresolved money/ })).not.toBeInTheDocument();
});

it("falls back from a queue deep link when tenant.management is missing", () => {
  mockKeys = ["sales.view"];
  mockParams = new URLSearchParams("view=incident-notes");
  render(<SalesPage />);
  expect(screen.getByText("History content")).toBeInTheDocument();
  expect(screen.queryByText("Incident queue")).not.toBeInTheDocument();
});

it("shows recovery queue tabs with tenant.management", () => {
  mockKeys = ["sales.view", "tenant.management"];
  render(<SalesPage />);
  expect(screen.getByRole("link", { name: /Incident notes/ })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Payment recovery/ })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Unresolved money/ })).toBeInTheDocument();
});

it("deep links open Phase D tabs with matching hrefs", () => {
  render(<SalesPage />);
  expect(screen.getByRole("link", { name: /Incident notes/ })).toHaveAttribute(
    "href",
    "/sales?view=incident-notes",
  );
  expect(screen.getByRole("link", { name: /Payment recovery/ })).toHaveAttribute(
    "href",
    "/sales?view=payment-recovery",
  );
  expect(screen.getByRole("link", { name: /Unresolved money/ })).toHaveAttribute(
    "href",
    "/sales?view=unresolved-money",
  );

  mockParams = new URLSearchParams("view=incident-notes");
  const view = render(<SalesPage />);
  expect(screen.getByText("Incident queue")).toBeInTheDocument();

  mockParams = new URLSearchParams("view=payment-recovery");
  view.rerender(<SalesPage />);
  expect(screen.getByText("Payment queue")).toBeInTheDocument();

  mockParams = new URLSearchParams("view=unresolved-money");
  view.rerender(<SalesPage />);
  expect(screen.getByText("Money queue")).toBeInTheDocument();
});
