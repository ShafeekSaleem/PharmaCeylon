import { render, screen } from "@testing-library/react";
import GetStartedPage from "./page";
import { fetchSetupReadiness } from "@/lib/setup-readiness-client";

jest.mock("@/lib/use-auth", () => ({
  useAuth: () => ({ branchId: "branch-a" }),
}));
jest.mock("@/lib/use-role-access", () => ({
  useRoleAccess: () => ({ userRoles: ["owner"] }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn() }),
}));
jest.mock("@/lib/setup-readiness-client", () => ({
  fetchSetupReadiness: jest.fn(),
  confirmSetupTask: jest.fn(),
  completeSetupJourney: jest.fn(),
  notifySetupJourneyChanged: jest.fn(),
}));
jest.mock("../products/import/components/opening-stock-drafts", () => ({
  OpeningStockDrafts: () => <div>Opening-stock drafts</div>,
}));
const base = {
  journeyEnabled: true,
  readyForSales: false,
  completedCount: 0,
  totalCount: 3,
  percent: 0,
  tenant: { id: "tenant", name: "Pharmacy", hasLogo: true },
  branch: {
    id: "branch-a",
    name: "Main",
    code: "MAIN",
    setupMode: "fresh",
    desktopPosLive: true,
    plannedCounterCount: 2,
  },
  desktopSetup: {
    enrolledCounters: 1,
    staffPrepared: false,
    testReceipt: false,
  },
  optional: {
    teamInvited: true,
    logoAdded: true,
    catalogOrganized: true,
    catalogCoverage: { ranged: 1, categorized: 1, unplaced: 0, percent: 100 },
  },
  nextTask: "checkout",
  tasks: [
    {
      key: "opening_inventory",
      title: "Stage and post opening stock",
      description: "Stage on the web",
      complete: false,
      available: true,
      href: "/products/import?mode=stage",
      facts: [{ label: "Units counted", value: "10" }],
    },
    {
      key: "sales_settings",
      title: "Review sales settings",
      description: "Review settings",
      complete: true,
      available: true,
      href: "/settings/main",
    },
    {
      key: "checkout",
      title: "Install PharmaCeylon POS and enroll your first counter",
      description: "Desktop setup pending",
      complete: false,
      available: true,
      href: "/settings/branches",
      facts: [
        { label: "Enrolled counters", value: "1" },
        {
          label: "Printed test receipt",
          value: "Pending desktop support",
          ok: false,
        },
      ],
    },
  ],
};
it("shows counter dependencies without a ready-to-sell action, but still confirms posted stock", async () => {
  (fetchSetupReadiness as jest.Mock).mockResolvedValue(base);
  render(<GetStartedPage />);
  expect(await screen.findByText("Counter setup pending")).toBeInTheDocument();
  expect(screen.getByText("Prepare staff for the counter")).toBeInTheDocument();
  expect(
    screen.getByText("Choose an offline counter — optional"),
  ).toBeInTheDocument();
  // There is no counter-side confirmation yet; hiding this would strand the journey.
  expect(
    screen.getByRole("button", { name: "These are correct" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Ready to sell" }),
  ).not.toBeInTheDocument();
  expect(document.querySelector('a[href^="/pos"]')).toBeNull();
});
it("keeps legacy not-live checkout actions available", async () => {
  (fetchSetupReadiness as jest.Mock).mockResolvedValue({
    ...base,
    desktopSetup: undefined,
    branch: { ...base.branch, desktopPosLive: false },
    tasks: [{ ...base.tasks[2], href: "/pos?setup=checkout" }],
  });
  render(<GetStartedPage />);
  expect(
    await screen.findByRole("button", { name: "Ready to sell" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Open the till" })).toHaveAttribute(
    "href",
    "/pos?setup=checkout",
  );
});
