import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { CashierDashboard } from "../roles/cashier-dashboard";
import { PharmacistDashboard } from "../roles/pharmacist-dashboard";
import type { DashboardData } from "../hooks/use-dashboard-data";
import type { UseDashboardLayoutResult } from "../hooks/use-dashboard-layout";
import { catalogForRole } from "../widgets/registry";
import {
  dashboardHref,
  dashboardPosHidden,
  isPosHref,
  PosHiddenContext,
} from "./pos-links";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("../components/dashboard-canvas", () => ({
  DashboardCanvas: () => null,
}));
jest.mock("../hooks/use-customer-breakdown", () => ({
  useCustomerBreakdown: () => ({ data: null }),
}));
jest.mock("@/components/role-access", () => ({
  RoleLink: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

const data = {
  loading: false,
  branchId: "branch-1",
  branchName: "Colombo 03",
  todaySalesTotal: 1200,
  todaySalesCount: 4,
  salesTrendLabel: null,
  salesTrendPositive: true,
  billsTrendLabel: null,
  billsTrendPositive: true,
  holdCount: 7,
  holdValue: 900,
  pharmacistHolds: [],
  returnsTodayCount: 1,
  returnsTodayTotal: 100,
  hourlyToday: [],
  hourlyUnitsToday: [],
  lowStockRows: [],
  lowStockCount: 0,
  nearExpiryCount: 0,
  nearExpiryItems: [],
  dispensedToday: 10,
  dispensedTrendLabel: null,
  dispensedTrendPositive: true,
  controlledAttentionCount: 0,
  controlledLowStockCount: 0,
  controlledNearExpiryCount: 0,
  salesMetrics: { scope: "personal", holds: { count: 7, value: 900, pharmacist: 2 } },
  failedSections: new Set<string>(),
} as unknown as DashboardData;
const layout = { layout: [] } as unknown as UseDashboardLayoutResult;

function posLinks(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("a"))
    .map((a) => a.getAttribute("href") ?? "")
    .filter((href) => isPosHref(href));
}

describe("dashboard /pos links (W9 #71)", () => {
  it("treats a live branch, and an unknown one, as having no web POS", () => {
    expect(dashboardPosHidden(null)).toBe(true);
    expect(dashboardPosHidden({ state: "live", liveSince: null, fallback: null })).toBe(true);
    expect(dashboardPosHidden({ state: "not_live", liveSince: null, fallback: null })).toBe(false);
    expect(
      dashboardPosHidden({
        state: "fallback",
        liveSince: null,
        fallback: { startedAt: "2026-10-28T00:00:00Z", endsAt: "2099-01-01T00:00:00Z" },
      }),
    ).toBe(false);
  });

  it("drops only web-POS links", () => {
    expect(isPosHref("/pos?panel=holds")).toBe(true);
    expect(isPosHref("/position-report")).toBe(false);
    expect(dashboardHref("/pos", true)).toBeUndefined();
    expect(dashboardHref("/pos", false)).toBe("/pos");
    expect(dashboardHref("/prescriptions", true)).toBe("/prescriptions");
  });

  it.each([
    ["cashier", CashierDashboard],
    ["pharmacist", PharmacistDashboard],
  ])("the %s dashboard opens no /pos link at a live branch", (_role, Dashboard) => {
    const notLive = render(<Dashboard data={data} catalog={[]} layout={layout} />);
    expect(posLinks(notLive.container).length).toBeGreaterThan(0);
    notLive.unmount();

    const live = render(
      <PosHiddenContext.Provider value>
        <Dashboard data={data} catalog={[]} layout={layout} />
      </PosHiddenContext.Provider>,
    );
    expect(posLinks(live.container)).toEqual([]);
  });

  it("shrinks the cashier dashboard to a counter handoff and drops held bills at a live branch", () => {
    render(
      <PosHiddenContext.Provider value>
        <CashierDashboard data={data} catalog={[]} layout={layout} />
      </PosHiddenContext.Provider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Do this at the counter in PharmaCeylon POS.",
    );
    expect(screen.queryByText("Branch Held Bills")).not.toBeInTheDocument();
    expect(catalogForRole("cashier", true).map((w) => w.key)).not.toContain("cashier.held-bills");
    expect(catalogForRole("cashier", false).map((w) => w.key)).toContain("cashier.held-bills");
  });

  it("sends pharmacists to the prescriptions register, not /pos", () => {
    const { container } = render(<PharmacistDashboard data={data} catalog={[]} layout={layout} />);
    expect(screen.getByRole("link", { name: "Open prescriptions" })).toHaveAttribute(
      "href",
      "/prescriptions",
    );
    expect(container.querySelector('a[href^="/pos?panel=holds"]')).toBeNull();
  });

  it("offers the waiting-at-the-counter widget to managers and owners", () => {
    expect(catalogForRole("manager").map((w) => w.key)).toContain("counter.waiting");
    expect(catalogForRole("owner").map((w) => w.key)).toContain("counter.waiting");
    expect(catalogForRole("cashier").map((w) => w.key)).not.toContain("counter.waiting");
  });
});
