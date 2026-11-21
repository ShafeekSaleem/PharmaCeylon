import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PageHeader } from "@/components/ui/page-header";
import { apiJson } from "@/lib/auth-client";
import {
  notifyPosRolloutChanged,
  resetBranchRolloutCache,
  type PosRollout,
} from "@/lib/branch-rollout";
import { AppShell, buildBreadcrumbs } from "./app-shell";

const push = jest.fn();
let mockPathname = "/dashboard";
let mockSearch = "";
let mockBackOfficeAccess = true;
let mockAccessResolved = true;
jest.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useSearchParams: () => new URLSearchParams(mockSearch),
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
  const view = render(
    <AppShell>
      <p>Page body</p>
    </AppShell>,
  );
  await waitFor(() => expect(request).toHaveBeenCalledWith("/tenant/context"));
  // Let the context answer land.
  await act(async () => {});
  return view;
}

beforeEach(() => {
  resetBranchRolloutCache();
  sessionStorage.clear();
  mockPathname = "/dashboard";
  mockSearch = "";
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
    expect(screen.queryByRole("link", { name: "Sales", exact: true })).not.toBeInTheDocument();
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

  it("unmounts a back-office page when the branch goes live and the rollout refresh fails", async () => {
    mockBackOfficeAccess = false;
    mockPathname = "/inventory";
    await renderShell();
    expect(screen.getByText("Page body")).toBeInTheDocument();

    // The owner moves the branch live; this tab's forced re-read of the context fails, while
    // its permissions resolve without back-office scope.
    rollout = LIVE;
    request.mockImplementation(async (path: string) => {
      if (path === "/tenant/context") throw new Error("offline");
      return { groups: [] } as never;
    });
    await act(async () => notifyPosRolloutChanged());

    await waitFor(() => expect(screen.queryByText("Page body")).not.toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("Web access could not be checked");
    expect(posNavLink()).not.toBeInTheDocument();
    expect(quickSale()).not.toBeInTheDocument();

    // The next read that lands establishes the scope again.
    request.mockImplementation(
      async (path: string) =>
        (path === "/tenant/context" ? contextResponse() : { groups: [] }) as never,
    );
    await act(async () => notifyPosRolloutChanged());
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Use PharmaCeylon POS" })).toBeInTheDocument(),
    );
    expect(screen.queryByText("Page body")).not.toBeInTheDocument();
  });

  it("applies a successful rollout refresh to the page in place", async () => {
    mockBackOfficeAccess = false;
    mockPathname = "/inventory";
    await renderShell();
    expect(screen.getByText("Page body")).toBeInTheDocument();

    rollout = LIVE;
    await act(async () => notifyPosRolloutChanged());
    await waitFor(() => expect(screen.queryByText("Page body")).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Use PharmaCeylon POS" })).toBeInTheDocument();

    // Back-office scope keeps the page open at a live branch.
    mockBackOfficeAccess = true;
    await act(async () => notifyPosRolloutChanged());
    await waitFor(() => expect(screen.getByText("Page body")).toBeInTheDocument());
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

describe("#205 settings menu replaces the main sidebar", () => {
  it("swaps the main nav for the settings menu inside Settings", async () => {
    mockPathname = "/settings/approval-rules";
    mockKeys = ["tenant.management"];
    await renderShell();
    expect(screen.queryByRole("navigation", { name: "Main" })).not.toBeInTheDocument();
    const menu = screen.getByRole("navigation", { name: "Settings" });
    expect(within(menu).getByRole("link", { name: "Back to app" })).toHaveAttribute(
      "href",
      "/dashboard",
    );
    expect(within(menu).getByRole("link", { name: "Approval Rules" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    // Each group says once who its changes reach.
    expect(
      within(menu).getByRole("group", {
        name: "You: Your account (owner settings for everyone are marked on the page)",
      }),
    ).toBeInTheDocument();
    expect(within(menu).getByRole("group", { name: "At the counter: Everyone" })).toBeInTheDocument();
  });

  it("returns to the last page you had open outside Settings", async () => {
    mockPathname = "/customers";
    mockSearch = "status=active";
    const view = await renderShell();
    expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument();
    mockPathname = "/settings/my-profile";
    view.rerender(
      <AppShell>
        <p>Page body</p>
      </AppShell>,
    );
    const menu = await screen.findByRole("navigation", { name: "Settings" });
    await waitFor(() =>
      expect(within(menu).getByRole("link", { name: "Back to app" })).toHaveAttribute(
        "href",
        "/customers?status=active",
      ),
    );
  });

  it("offers only your own pages and no way back at a live branch without back-office access", async () => {
    rollout = LIVE;
    mockBackOfficeAccess = false;
    mockKeys = ["tenant.management"];
    mockPathname = "/dashboard";
    const view = await renderShell();
    mockPathname = "/settings/my-profile";
    view.rerender(
      <AppShell>
        <p>Page body</p>
      </AppShell>,
    );
    const menu = await screen.findByRole("navigation", { name: "Settings" });
    expect(within(menu).getAllByRole("link").map((link) => link.textContent)).toEqual([
      "Settings",
      "My Profile",
      "Password & Login",
      "Appearance",
    ]);
    // The dashboard would only say "Use PharmaCeylon POS", so there is no link back to it.
    expect(within(menu).queryByRole("link", { name: "Back to app" })).not.toBeInTheDocument();
  });

  it("gives the older report and alert pages a home in the menu", async () => {
    mockPathname = "/settings/insights-reports";
    mockKeys = ["tenant.management"];
    await renderShell();
    const menu = screen.getByRole("navigation", { name: "Settings" });
    expect(within(menu).getByRole("link", { name: "Insights & Reports" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(menu).getByRole("link", { name: "Recipients & Channels" })).toBeInTheDocument();
  });

  it("shows only your own pages without tenant management", async () => {
    mockPathname = "/settings/my-profile";
    mockKeys = [];
    await renderShell();
    const menu = screen.getByRole("navigation", { name: "Settings" });
    expect(within(menu).getByRole("link", { name: "Password & Login" })).toBeInTheDocument();
    expect(within(menu).queryByRole("link", { name: "Branches" })).not.toBeInTheDocument();
    expect(within(menu).queryByRole("group", { name: /Pharmacy/ })).not.toBeInTheDocument();
  });

  it("names settings pages by their display name", () => {
    expect(buildBreadcrumbs("/settings/counters")).toEqual([
      { label: "Settings", href: "/settings" },
      { label: "Counters" },
    ]);
    expect(buildBreadcrumbs("/settings/tenant-profile").at(-1)).toEqual({
      label: "Organization Profile",
    });
  });
});

describe("#205 web shell: one title, one scope control, quiet sidebar", () => {
  it("shows the page title once, in the page, and no breadcrumb on a top-level page", async () => {
    mockPathname = "/customers";
    await renderShell();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Customers");
    expect(screen.getByRole("banner")).not.toHaveTextContent("Customers");
    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).not.toBeInTheDocument();
  });

  it("leaves the title to a page that draws its own heading", async () => {
    mockPathname = "/customers";
    render(
      <AppShell>
        <h1>Customers from the page</h1>
      </AppShell>,
    );
    await waitFor(() => expect(request).toHaveBeenCalledWith("/tenant/context"));
    await waitFor(() => expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1));
    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent("Customers from the page");
  });

  it("lets PageHeader take the shell's name for the page", async () => {
    mockPathname = "/products/import";
    render(
      <AppShell>
        <PageHeader subtitleOnly description="Upload your product list." />
      </AppShell>,
    );
    await waitFor(() => expect(request).toHaveBeenCalledWith("/tenant/context"));
    // The shell's own title steps aside once it sees the page's heading.
    await waitFor(() => expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1));
    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings[0]).toHaveTextContent("Import products");
  });

  it("keeps the breadcrumb only for the parents of a nested page", async () => {
    mockPathname = "/settings/appearance";
    await renderShell();
    const crumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(crumb).toHaveTextContent("Settings");
    expect(crumb).not.toHaveTextContent("Appearance");
    expect(within(crumb).getByRole("link", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Appearance");
  });

  it("puts the branch switch in the top bar and nowhere else", async () => {
    await renderShell();
    const banner = screen.getByRole("banner");
    await waitFor(() =>
      expect(
        within(banner).getByRole("button", { name: "Branch: Colombo. Switch branch" }),
      ).toBeInTheDocument(),
    );
    expect(screen.getAllByRole("button", { name: /Switch branch/ })).toHaveLength(1);
    expect(within(banner).queryByText(/New sale/i)).not.toBeInTheDocument();
  });

  it("keeps the branch switch off settings pages, as before", async () => {
    mockPathname = "/settings/my-profile";
    await renderShell();
    expect(screen.queryByRole("button", { name: /Switch branch/ })).not.toBeInTheDocument();
  });

  it("moves full screen into the account menu without changing its shortcut", async () => {
    await renderShell();
    expect(screen.queryByRole("button", { name: /fullscreen/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "User menu" }));
    expect(screen.getByRole("button", { name: /full screen/i })).toHaveTextContent("Ctrl+Shift+F");
  });

  it("heads a sidebar group only when it has more than one item", async () => {
    await renderShell();
    const nav = screen.getByRole("navigation", { name: "Main" });
    // Dispensary has Customers and Prescriptions; Sales and Catalog have one item each.
    expect(within(nav).getByRole("group", { name: "Dispensary" })).toBeInTheDocument();
    expect(within(nav).queryByText("Catalog")).not.toBeInTheDocument();
    expect(within(nav).getAllByText("Sales")).toHaveLength(1);
  });

  it("badges a sidebar link with the work waiting there", async () => {
    mockKeys = ["purchasing.view", "inventory.view"];
    request.mockImplementation(async (path: string) => {
      if (path === "/tenant/context") return contextResponse() as never;
      if (path.startsWith("/dashboard/work?"))
        return { categories: { purchasing: 3, inventory: 0 } } as never;
      return { groups: [] } as never;
    });
    await renderShell();
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(
      await within(nav).findByRole("link", { name: "Purchasing 3 need action" }),
    ).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "Inventory" })).toBeInTheDocument();
  });

  it("drops a group's heading once its other items are hidden", async () => {
    rollout = LIVE;
    await renderShell();
    const nav = screen.getByRole("navigation", { name: "Main" });
    // Main is Dashboard + POS; with POS hidden at a live branch, Dashboard stands alone.
    expect(within(nav).queryByText("Main")).not.toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "Dashboard" })).toBeInTheDocument();
  });

  it("names the page the same in the title and as a parent", () => {
    expect(buildBreadcrumbs("/settings/appearance")).toEqual([
      { label: "Settings", href: "/settings" },
      { label: "Appearance" },
    ]);
    expect(buildBreadcrumbs("/inventory/offline-records").at(-1)).toEqual({
      label: "Offline records",
    });
    expect(buildBreadcrumbs("/sales/3f2c9a7e-1b2d-4c5e-8f90-123456789abc").at(-1)).toEqual({
      label: "Details",
    });
    expect(buildBreadcrumbs("/sales/3f2c9a7e-1b2d-4c5e-8f90-123456789abc", "INV-1")).toEqual([
      { label: "Sales", href: "/sales" },
      { label: "INV-1" },
    ]);
  });
});
