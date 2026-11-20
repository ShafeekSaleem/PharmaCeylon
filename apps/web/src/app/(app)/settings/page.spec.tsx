import { fireEvent, render, screen, within } from "@testing-library/react";
import SettingsHomePage from "./page";
import { fetchTenantSettings } from "./lib/tenant-settings";
import { countersApi } from "./counters/counters-api";

const push = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

let grantedKeys = ["tenant.management"];
let backOfficeAccess = true;
jest.mock("@/lib/permissions", () => ({
  usePermissions: () => ({
    permissionKeys: grantedKeys,
    backOfficeAccess,
    accessResolved: true,
  }),
}));

let rolloutState: "not_live" | "live" = "not_live";
jest.mock("@/lib/branch-rollout", () => ({
  useBranchRollout: () => ({ rollout: { state: rolloutState } }),
}));

jest.mock("@/lib/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u-1", fullName: "Seed Owner", email: "owner@example.test" },
    branchId: "b-1",
  }),
}));

jest.mock("@/lib/auth-client", () => ({
  fetchTenantBranches: jest.fn().mockResolvedValue([
    { id: "b-1", code: "MAIN", name: "Colombo", city: null, timezone: "Asia/Colombo" },
    { id: "b-2", code: "KDY", name: "Kandy", city: null, timezone: "Asia/Colombo" },
  ]),
}));
jest.mock("@/lib/notifications-client", () => ({
  fetchNotificationPreferences: jest.fn().mockResolvedValue({
    inventoryEnabled: true,
    expiryEnabled: false,
    purchasingEnabled: true,
    transfersEnabled: true,
    stocktakesEnabled: true,
    salesEnabled: false,
    complianceEnabled: true,
    systemEnabled: true,
  }),
}));
jest.mock("./lib/tenant-settings", () => ({ fetchTenantSettings: jest.fn() }));
jest.mock("./tenant-profile/api", () => ({
  fetchTenantProfile: jest.fn().mockResolvedValue({ displayName: "Demo Pharmacy", logoUrl: null }),
}));
jest.mock("./counters/counters-api", () => ({ countersApi: { counters: jest.fn() } }));
jest.mock("./offline-policy/counter-restore-api", () => ({
  counterRestoreApi: () => ({
    list: jest.fn().mockResolvedValue({
      restores: [{ status: "awaiting_acknowledgement" }, { status: "acknowledged" }],
    }),
  }),
}));
jest.mock("./offline-policy/journal-recovery-api", () => ({
  journalRecoveryApi: () => ({
    list: jest.fn().mockResolvedValue({
      recoveries: [{ status: "awaiting_approval", stale: true }],
    }),
  }),
}));

beforeEach(() => {
  grantedKeys = ["tenant.management"];
  backOfficeAccess = true;
  rolloutState = "not_live";
  push.mockReset();
  (fetchTenantSettings as jest.Mock).mockResolvedValue({
    passwordMinLength: 8,
    receiptPaperSize: "80mm",
    posMaxDiscountPercent: 10,
    vatRatePercent: 18,
    lowStockThresholdUnits: 10,
    expiryWarningDays: 90,
    approvalRequiredPurchaseOrderThreshold: null,
    approvalRequiredForBranchTransfers: true,
    approvalRequiredReturnThreshold: 5000,
    approvalRequiredWriteOffThreshold: null,
  });
  (countersApi.counters as jest.Mock).mockResolvedValue([]);
});

function card(name: string) {
  return screen.getByRole("link", { name: new RegExp(`^${name}`) });
}

it("groups the cards, states each group's scope and shows current values", async () => {
  render(<SettingsHomePage />);
  const you = screen.getByRole("region", { name: "You" });
  expect(within(you).getByText("Only your account")).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "At the counter" })).toHaveTextContent("Everyone");

  expect(await screen.findByText("Demo Pharmacy")).toBeInTheDocument();
  expect(card("My Profile")).toHaveTextContent("Seed Owner · owner@example.test");
  expect(card("Branches")).toHaveTextContent("2 branches");
  expect(card("Catalog")).toHaveTextContent("VAT 18%");
  expect(card("Approval Rules")).toHaveTextContent("3 of 5 rules on");
  expect(card("Notifications")).toHaveTextContent("1 alert type turned off");
  expect(card("Counters & devices")).toHaveTextContent("No counters at Colombo");
});

it("lists what needs attention, and leaves out stale or finished work", async () => {
  render(<SettingsHomePage />);
  const attention = screen.getByRole("region", { name: "Needs attention" });
  expect(
    await within(attention).findByText("1 restored counter waiting for you"),
  ).toBeInTheDocument();
  expect(within(attention).getByText("No pharmacy logo")).toBeInTheDocument();
  expect(within(attention).queryByText(/journal recover/)).not.toBeInTheDocument();
  // Counters only matter once the branch sells on the desktop app.
  expect(within(attention).queryByText(/No counters/)).not.toBeInTheDocument();
});

it("asks for counters at a branch live on the desktop app", async () => {
  rolloutState = "live";
  render(<SettingsHomePage />);
  const attention = screen.getByRole("region", { name: "Needs attention" });
  expect(await within(attention).findByText("No counters at Colombo")).toBeInTheDocument();
});

it("finds a setting by a field inside it and opens the first result on Enter", async () => {
  render(<SettingsHomePage />);
  const search = screen.getByRole("searchbox", { name: "Search settings" });
  fireEvent.change(search, { target: { value: "refund limit" } });
  const results = screen.getByRole("region", { name: "Search results" });
  expect(within(results).getByRole("link", { name: /Approval Rules/ })).toHaveTextContent(
    "Includes “refund limit”",
  );
  expect(screen.queryByRole("region", { name: "You" })).not.toBeInTheDocument();
  fireEvent.keyDown(search, { key: "Enter" });
  expect(push).toHaveBeenCalledWith("/settings/approval-rules");

  fireEvent.change(search, { target: { value: "zzz" } });
  expect(screen.getByText("No setting matches “zzz”.")).toBeInTheDocument();
  // Escape clears the search and brings the cards back.
  fireEvent.keyDown(search, { key: "Escape" });
  expect(await screen.findByText("Demo Pharmacy")).toBeInTheDocument();
});

it("shows only your own settings without tenant management", async () => {
  grantedKeys = [];
  render(<SettingsHomePage />);
  expect(screen.queryByRole("region", { name: "Needs attention" })).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Pharmacy" })).not.toBeInTheDocument();
  expect(card("Password & Login")).toBeInTheDocument();
  expect(await screen.findByText("Passwords at least 8 characters")).toBeInTheDocument();
  expect(countersApi.counters).not.toHaveBeenCalled();
});
