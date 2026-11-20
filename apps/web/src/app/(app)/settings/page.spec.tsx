import { fireEvent, render, screen, within } from "@testing-library/react";
import SettingsHomePage from "./page";
import { fetchTenantBranches } from "@/lib/auth-client";
import { fetchTenantSettings } from "./lib/tenant-settings";
import { fetchTenantProfile } from "./tenant-profile/api";
import { countersApi } from "./counters/counters-api";
import { fetchCounterPolicy } from "./lib/counter-policy";

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

let selectedBranch: string | null = "b-1";
jest.mock("@/lib/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u-1", fullName: "Seed Owner", email: "owner@example.test" },
    branchId: selectedBranch,
  }),
}));

jest.mock("@/lib/auth-client", () => ({ fetchTenantBranches: jest.fn() }));
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
jest.mock("./tenant-profile/api", () => ({ fetchTenantProfile: jest.fn() }));
jest.mock("./counters/counters-api", () => ({
  countersApi: { counters: jest.fn() },
}));
jest.mock("./lib/counter-policy", () => ({ fetchCounterPolicy: jest.fn() }));
const mockRestoreList = jest.fn();
jest.mock("./offline-selling/counter-restore-api", () => ({
  counterRestoreApi: () => ({ list: () => mockRestoreList() }),
}));
const mockRecoveryList = jest.fn();
jest.mock("./offline-selling/journal-recovery-api", () => ({
  journalRecoveryApi: () => ({ list: () => mockRecoveryList() }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  grantedKeys = ["tenant.management", "inventory.view"];
  backOfficeAccess = true;
  rolloutState = "not_live";
  selectedBranch = "b-1";
  push.mockReset();
  (fetchTenantSettings as jest.Mock).mockResolvedValue({
    passwordMinLength: 8,
    receiptPaperSize: "80mm",
    posMaxDiscountPercent: 10,
    posAutoPrintReceipt: true,
    posDefaultPaymentMethod: "card",
    vatRatePercent: 18,
    lowStockThresholdUnits: 10,
    expiryWarningDays: 90,
    approvalRequiredPurchaseOrderThreshold: null,
    approvalRequiredForBranchTransfers: true,
    approvalRequiredReturnThreshold: 5000,
    approvalRequiredWriteOffThreshold: null,
  });
  (fetchTenantProfile as jest.Mock).mockReset();
  (fetchTenantProfile as jest.Mock).mockResolvedValue({
    displayName: "Demo Pharmacy",
    logoUrl: null,
  });
  (fetchTenantBranches as jest.Mock).mockReset();
  (fetchTenantBranches as jest.Mock).mockResolvedValue([
    {
      id: "b-1",
      code: "MAIN",
      name: "Colombo",
      city: null,
      timezone: "Asia/Colombo",
    },
    {
      id: "b-2",
      code: "KDY",
      name: "Kandy",
      city: null,
      timezone: "Asia/Colombo",
    },
  ]);
  (countersApi.counters as jest.Mock).mockReset();
  (countersApi.counters as jest.Mock).mockResolvedValue([]);
  (fetchCounterPolicy as jest.Mock).mockReset();
  (fetchCounterPolicy as jest.Mock).mockResolvedValue({
    policy: { onlinePaymentMethods: ["mobile_wallet"], offlineEnabled: true },
  });
  mockRestoreList.mockReset();
  mockRestoreList.mockResolvedValue({
    restores: [{ status: "awaiting_acknowledgement" }, { status: "acknowledged" }],
  });
  mockRecoveryList.mockReset();
  mockRecoveryList.mockResolvedValue({
    recoveries: [{ status: "awaiting_approval", stale: true }],
  });
});

function card(name: string) {
  return screen.getByRole("link", { name: new RegExp(`^${name}`) });
}

function attentionRegion() {
  return screen.getByRole("region", { name: /^Needs attention/ });
}

it("groups the cards, states each group's scope and shows current values", async () => {
  render(<SettingsHomePage />);
  const you = screen.getByRole("region", { name: "You" });
  expect(
    within(you).getByText("Your account (owner settings for everyone are marked on the page)"),
  ).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "At the counter" })).toHaveTextContent("Everyone");

  expect(await screen.findByText("Demo Pharmacy")).toBeInTheDocument();
  expect(card("My Profile")).toHaveTextContent("Seed Owner · owner@example.test");
  expect(card("Password & Login")).toHaveTextContent(
    "Pharmacy rule: passwords at least 8 characters",
  );
  expect(card("Branches")).toHaveTextContent("2 branches");
  expect(card("Catalog")).toHaveTextContent("VAT 18%");
  expect(card("Approval Rules")).toHaveTextContent("3 of 5 rules on");
  // Only the toggles this person sees count: Inventory and Expiry, and Branch & Tenant.
  expect(card("Notifications")).toHaveTextContent("1 alert type turned off");
  // "Counters & receipts" and "Counters & devices" are four pages now, each with its value.
  expect(card("Counters")).toHaveTextContent("No counters at Colombo");
  expect(card("Receipts")).toHaveTextContent("80 mm receipts · printed after every sale");
  // The pharmacy starts on card, but Colombo doesn't take card, so its counters start on cash.
  expect(card("Payments")).toHaveTextContent("Cash and mobile wallet at Colombo · starts on cash");
  expect(card("Offline selling")).toHaveTextContent("Allowed at Colombo");
});

it("names the branch it checked, lists what needs attention, and flags stale recoveries", async () => {
  render(<SettingsHomePage />);
  expect(await screen.findByRole("heading", { name: "Needs attention at Colombo" })).toBeVisible();
  const attention = attentionRegion();
  expect(
    await within(attention).findByText("1 restored counter at Colombo waiting for you"),
  ).toBeInTheDocument();
  expect(
    within(attention).getByText("1 counter journal recovery at Colombo out of date"),
  ).toBeInTheDocument();
  expect(within(attention).getByText("No pharmacy logo")).toBeInTheDocument();
  expect(within(attention).queryByText(/waiting for approval/)).not.toBeInTheDocument();
  // Counters only matter once the branch sells on the desktop app.
  expect(within(attention).queryByText(/No counters/)).not.toBeInTheDocument();
});

it("asks for counters at a branch live on the desktop app", async () => {
  rolloutState = "live";
  render(<SettingsHomePage />);
  expect(await within(attentionRegion()).findByText("No counters at Colombo")).toBeInTheDocument();
});

it("says all clear, at the branch it checked, only when every check ran", async () => {
  (fetchTenantProfile as jest.Mock).mockResolvedValue({
    displayName: "A",
    logoUrl: "/logo.png",
  });
  mockRestoreList.mockResolvedValue({ restores: [] });
  mockRecoveryList.mockResolvedValue({ recoveries: [] });
  render(<SettingsHomePage />);
  expect(
    await within(attentionRegion()).findByText("Nothing needs your attention at Colombo."),
  ).toBeInTheDocument();
});

it("never says all clear when a check could not run", async () => {
  (fetchTenantProfile as jest.Mock).mockResolvedValue({
    displayName: "A",
    logoUrl: "/logo.png",
  });
  mockRestoreList.mockRejectedValue(new Error("Forbidden"));
  mockRecoveryList.mockResolvedValue({ recoveries: [] });
  render(<SettingsHomePage />);
  const attention = attentionRegion();
  expect(
    await within(attention).findByText("Couldn't check restored counters at Colombo"),
  ).toBeInTheDocument();
  expect(within(attention).queryByText(/Nothing needs your attention/)).not.toBeInTheDocument();
});

it("says the branch checks could not run without a branch", async () => {
  selectedBranch = null;
  (fetchTenantProfile as jest.Mock).mockResolvedValue({
    displayName: "A",
    logoUrl: "/logo.png",
  });
  render(<SettingsHomePage />);
  const attention = attentionRegion();
  expect(
    await within(attention).findByText("Couldn't check restored counters at this branch"),
  ).toBeInTheDocument();
  expect(within(attention).getAllByText("Choose a branch to check it.")).toHaveLength(2);
  expect(mockRestoreList).not.toHaveBeenCalled();
  expect(within(attention).queryByText(/Nothing needs your attention/)).not.toBeInTheDocument();
});

it("finds a setting by a field inside it, announces the count and opens the first on Enter", async () => {
  render(<SettingsHomePage />);
  const search = screen.getByRole("searchbox", { name: "Search settings" });
  fireEvent.change(search, { target: { value: "refund limit" } });
  const results = screen.getByRole("region", { name: "Search results" });
  expect(within(results).getByRole("status")).toHaveTextContent(
    "1 setting found. Enter opens Approval Rules.",
  );
  expect(within(results).getByRole("link", { name: /Approval Rules/ })).toHaveTextContent(
    "Includes “refund limit”",
  );
  expect(screen.queryByRole("region", { name: "You" })).not.toBeInTheDocument();
  fireEvent.keyDown(search, { key: "Enter" });
  expect(push).toHaveBeenCalledWith("/settings/approval-rules");

  fireEvent.change(search, { target: { value: "zzz" } });
  expect(screen.getByRole("status")).toHaveTextContent("No setting matches “zzz”.");
  // Escape clears the search and brings the cards back.
  fireEvent.keyDown(search, { key: "Escape" });
  expect(await screen.findByText("Demo Pharmacy")).toBeInTheDocument();
});

it("shows only your own settings without tenant management", async () => {
  grantedKeys = [];
  render(<SettingsHomePage />);
  expect(screen.queryByRole("region", { name: /Needs attention/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Pharmacy" })).not.toBeInTheDocument();
  expect(card("Password & Login")).toBeInTheDocument();
  expect(
    await screen.findByText("Pharmacy rule: passwords at least 8 characters"),
  ).toBeInTheDocument();
  expect(countersApi.counters).not.toHaveBeenCalled();
});

it("makes no admin reads at a desktop-live branch without back-office access", async () => {
  rolloutState = "live";
  backOfficeAccess = false;
  render(<SettingsHomePage />);
  expect(screen.queryByRole("region", { name: /Needs attention/ })).not.toBeInTheDocument();
  expect(screen.getAllByRole("link")).toHaveLength(3);
  expect(card("My Profile")).toBeInTheDocument();
  expect(card("Password & Login")).toBeInTheDocument();
  expect(card("Appearance")).toBeInTheDocument();
  expect(await screen.findByText("Seed Owner · owner@example.test")).toBeInTheDocument();
  expect(fetchTenantSettings).not.toHaveBeenCalled();
  expect(fetchTenantProfile).not.toHaveBeenCalled();
  expect(fetchTenantBranches).not.toHaveBeenCalled();
  expect(countersApi.counters).not.toHaveBeenCalled();
  expect(mockRestoreList).not.toHaveBeenCalled();
  expect(mockRecoveryList).not.toHaveBeenCalled();
});
