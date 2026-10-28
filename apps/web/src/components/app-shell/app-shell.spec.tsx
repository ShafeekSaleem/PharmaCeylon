import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { apiJson } from "@/lib/auth-client";
import {
  notifyPosRolloutChanged,
  resetBranchRolloutCache,
  type PosRollout,
} from "@/lib/branch-rollout";
import { AppShell } from "./app-shell";

const push = jest.fn();
let mockPathname = "/dashboard";
let mockBackOfficeAccess = true;
let mockAccessResolved = true;
jest.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push, replace: jest.fn() }),
}));

let mockRoles: Array<{ branchId: string; role: string }> = [];
jest.mock("@/lib/use-auth", () => ({
  useAuth: () => ({
    user: {
      id: "user-1",
      tenantId: "t-1",
      email: "u@example.com",
      fullName: "Una User",
      avatarUrl: null,
      roles: mockRoles.map((r) => r.role),
      branchRoles: mockRoles,
    },
    ready: true,
    isAuthenticated: true,
    branchId: "b-1",
    setBranchId: jest.fn(),
    logout: jest.fn(),
  }),
}));

let mockKeys: string[] = [];
jest.mock("@/lib/permissions", () => ({
  ...jest.requireActual("@/lib/permissions"),
  usePermissions: () => ({
    permissionKeys: mockKeys,
    canSelfApprove: false,
    backOfficeAccess: mockBackOfficeAccess,
    accessResolved: mockAccessResolved,
    loading: false,
    hasLoadedOnce: true,
  }),
}));

jest.mock("@/lib/auth-client", () => ({
  apiJson: jest.fn(),
  fetchTenantBranches: jest.fn().mockResolvedValue([
    {
      id: "b-1",
      code: "CMB",
      name: "Colombo",
      city: null,
      timezone: "Asia/Colombo",
    },
  ]),
  fetchTenantDisplayName: jest.fn().mockResolvedValue("Tenant"),
  BRANCHES_CHANGED_EVENT: "pharmaceylon-branches-changed",
}));
jest.mock("@/lib/setup-readiness-client", () => ({
  fetchSetupReadiness: jest.fn().mockResolvedValue({ journeyEnabled: false }),
  SETUP_JOURNEY_CHANGED_EVENT: "pharmaceylon-setup-journey-changed",
}));
jest.mock("@/components/notifications/notification-center", () => ({
  NotificationCenter: () => null,
}));

const request = jest.mocked(apiJson);
const NOT_LIVE: PosRollout = {
  state: "not_live",
  liveSince: null,
  fallback: null,
};
const LIVE: PosRollout = {
  state: "live",
  liveSince: "2026-10-01T00:00:00Z",
  fallback: null,
};
const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

let rollout: PosRollout = NOT_LIVE;
function contextResponse() {
  return {
    branchRoles: [
      {
        branchId: "b-1",
        role: "cashier",
        branch: { id: "b-1", posRollout: rollout },
      },
    ],
  };
}

function posNavLink() {
  return screen.queryByRole("link", { name: "POS / Checkout" });
}
function quickSale() {
  return screen.queryByRole("link", { name: /Start a new sale/ });
}

async function renderShell() {
  render(
    <AppShell>
      <p>Page body</p>
    </AppShell>,
  );
  await waitFor(() => expect(request).toHaveBeenCalledWith("/tenant/context"));
  // Let the context answer land.
  await act(async () => {});
}

beforeEach(() => {
  resetBranchRolloutCache();
  mockPathname = "/dashboard";
  mockBackOfficeAccess = true;
  mockAccessResolved = true;
  rollout = NOT_LIVE;
  mockRoles = [{ branchId: "b-1", role: "cashier" }];
  mockKeys = ["sales.pos_use", "customers.view", "prescriptions.view"];
  push.mockReset();
  request.mockReset();
  request.mockImplementation(
    async (path: string) =>
      (path === "/tenant/context" ? contextResponse() : { groups: [] }) as never,
  );
});

describe("AppShell and the branch's desktop POS state", () => {
  it("keeps POS exactly as today at a branch that isn't live", async () => {
    await renderShell();
    await waitFor(() => expect(screen.getByText("Page body")).toBeInTheDocument());
    expect(posNavLink()).toHaveAttribute("href", "/pos");
    expect(quickSale()).toHaveAttribute("href", "/pos");
    expect(screen.queryByText(/Web POS fallback is on/)).not.toBeInTheDocument();

    fireEvent.keyDown(document, {
      code: "KeyP",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(push).toHaveBeenCalledWith("/pos");
  });

  it("hides POS navigation, Quick Sale and its shortcut once the branch is live", async () => {
    rollout = LIVE;
    await renderShell();
    expect(posNavLink()).not.toBeInTheDocument();
    expect(quickSale()).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Customers" })).toBeInTheDocument();

    fireEvent.keyDown(document, {
      code: "KeyP",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(push).not.toHaveBeenCalled();
  });

  it("brings POS back with a banner while a fallback runs", async () => {
    rollout = {
      state: "fallback",
      liveSince: "2026-10-01T00:00:00Z",
      fallback: { startedAt: inHours(-1), endsAt: inHours(3) },
    };
    await renderShell();
    expect(posNavLink()).toBeInTheDocument();
    expect(quickSale()).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      /Web POS fallback is on for this branch until .+\. Sales are recorded as fallback sales\./,
    );
    expect(screen.getByText("Page body")).toBeInTheDocument();
  });

  it("follows the switch when it flips without a reload", async () => {
    await renderShell();
    expect(posNavLink()).toBeInTheDocument();

    rollout = LIVE;
    await act(async () => notifyPosRolloutChanged());
    await waitFor(() => expect(posNavLink()).not.toBeInTheDocument());
    expect(quickSale()).not.toBeInTheDocument();

    rollout = NOT_LIVE;
    await act(async () => notifyPosRolloutChanged());
    await waitFor(() => expect(posNavLink()).toBeInTheDocument());
  });

  it("does not expose branch pages when rollout state cannot be checked", async () => {
    request.mockImplementation(async (path: string) => {
      if (path === "/tenant/context") throw new Error("offline");
      return { groups: [] } as never;
    });
    await renderShell();
    expect(posNavLink()).not.toBeInTheDocument();
    expect(quickSale()).not.toBeInTheDocument();
    expect(screen.queryByText("Page body")).not.toBeInTheDocument();
  });
});

describe("AppShell nav gates on permission keys, not built-in role names", () => {
  it("opens POS, Customers and Prescriptions to a custom role holding the keys", async () => {
    mockRoles = [{ branchId: "b-1", role: "custom" }];
    await renderShell();
    expect(posNavLink()).toHaveAttribute("href", "/pos");
    expect(screen.getByRole("link", { name: "Customers" })).toHaveAttribute("href", "/customers");
    expect(screen.getByRole("link", { name: "Prescriptions" })).toHaveAttribute(
      "href",
      "/prescriptions",
    );
  });

  it("restricts POS for a till role whose grant was removed", async () => {
    mockKeys = ["customers.view", "prescriptions.view"];
    await renderShell();
    expect(posNavLink()).not.toBeInTheDocument();
    expect(screen.getByText("POS / Checkout").closest("[aria-disabled]")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(quickSale()).not.toBeInTheDocument();
  });
});

describe("W3 back-office web scope", () => {
  it("never mounts a direct back-office page for a counter-only custom role at a live branch", async () => {
    rollout = LIVE;
    mockBackOfficeAccess = false;
    mockRoles = [{ branchId: "b-1", role: "custom" }];
    mockPathname = "/sales/private-sale";
    mockKeys = ["sales.pos_use", "sales.view", "inventory.view"];
    await renderShell();
    expect(screen.queryByText("Page body")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Use PharmaCeylon POS" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Sales history" })).not.toBeInTheDocument();
    expect(quickSale()).not.toBeInTheDocument();
    fireEvent.keyDown(document, {
      code: "KeyP",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(push).not.toHaveBeenCalled();
  });

  it("blocks content on a permission fetch failure, including before branch go-live", async () => {
    mockAccessResolved = false;
    await renderShell();
    expect(screen.queryByText("Page body")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Web access could not be checked");
  });

  it("keeps personal account pages available without back-office scope", async () => {
    rollout = LIVE;
    mockBackOfficeAccess = false;
    mockPathname = "/settings/my-profile";
    await renderShell();
    expect(screen.getByText("Page body")).toBeInTheDocument();
  });

  it("keeps web POS available in an owner fallback without granting the rest of the back office", async () => {
    rollout = {
      state: "fallback",
      liveSince: LIVE.liveSince,
      fallback: { startedAt: new Date().toISOString(), endsAt: inHours(2) },
    };
    mockBackOfficeAccess = false;
    mockPathname = "/pos";
    await renderShell();
    expect(screen.getByText("Page body")).toBeInTheDocument();
    expect(posNavLink()).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Customers" })).not.toBeInTheDocument();
  });
});
