import { render, screen } from "@testing-library/react";
import type { DashboardData } from "../hooks/use-dashboard-data";
import type { UseDashboardLayoutResult } from "../hooks/use-dashboard-layout";
import { OwnerDashboard } from "./owner-dashboard";
import { PosHiddenContext } from "../lib/pos-links";

jest.mock("../components/dashboard-canvas", () => ({
  DashboardCanvas: () => null,
}));

jest.mock("../components/dashboard-fixed-grid", () => {
  const connectivity = jest.requireActual("../lib/dashboard-connectivity");
  const { TodaysPriorities } = jest.requireActual("../components/todays-priorities");
  return {
    DashboardFixedGrid: ({
      data,
      refreshKey,
      counterLive,
    }: {
      data: Pick<DashboardData, "failedSections" | "error" | "loading" | "branchId">;
      refreshKey: string | null;
      counterLive: boolean;
    }) => {
      const serverUnreachable =
        connectivity.isDashboardServerUnreachable(data);
      const unavailable = connectivity.isFixedWidgetUnavailable(
        "owner.inventory-health",
        data,
        serverUnreachable,
      );
      return (
        <div data-testid="fixed-grid">
          <TodaysPriorities
            data={data as DashboardData}
            refreshKey={refreshKey}
            counterLive={counterLive}
            forceUnavailable={serverUnreachable}
          />
          {unavailable ? <p>Couldn&apos;t load inventory health.</p> : null}
        </div>
      );
    },
    isV6DashboardRole: (role: string) => role === "owner" || role === "manager",
  };
});

const layout = { layout: [] } as unknown as UseDashboardLayoutResult;

function ownerData(
  patch: Partial<DashboardData> & {
    failedSections?: Set<string>;
  },
): DashboardData {
  return {
    loading: false,
    refreshing: false,
    branchId: "branch-1",
    branchName: "Colombo",
    branchLabel: "Colombo",
    ownerScope: "this_branch",
    ownerScopeLabel: "This branch",
    ownerTodaySalesTotal: 999_999,
    ownerTodayTxnCount: 42,
    ownerSalesTrendLabel: "+12%",
    ownerSalesTrendPositive: true,
    ownerGrossProfit30d: 50_000,
    branchesReportingToday: 1,
    branchesReportingTotal: 2,
    hasMarginData: true,
    marginPct: 12,
    financial: {
      receivablesOutstanding: 10_000,
      receivablesCustomerCount: 3,
      payablesOutstanding: 5_000,
      payablesSupplierCount: 2,
    },
    salesTrend7d: [
      { label: "Mon", value: 1 },
      { label: "Tue", value: 2 },
    ],
    salesMetrics: { timezone: "Asia/Colombo" },
    purchaseOrders: [],
    overduePos: 0,
    inventory: null,
    ownerLowStock: 0,
    lowStockCount: 0,
    nearExpiryCount: 0,
    error: null,
    failedSections: new Set<string>(),
    reload: jest.fn(),
    ...patch,
  } as unknown as DashboardData;
}

describe("OwnerDashboard v6 offline states", () => {
  it("does not render the quick actions bar", () => {
    render(
      <PosHiddenContext.Provider value={false}>
        <OwnerDashboard
          data={ownerData({})}
          catalog={[]}
          layout={layout}
          refreshKey={null}
          counterLive={false}
        />
      </PosHiddenContext.Provider>,
    );
    expect(screen.queryByText(/Owner Quick Actions/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Quick actions/i)).not.toBeInTheDocument();
  });

  it("hides stale hero figures when the server is unreachable", () => {
    render(
      <PosHiddenContext.Provider value={false}>
        <OwnerDashboard
          data={ownerData({
            error: "Failed to fetch",
            failedSections: new Set([
              "Sales metrics",
              "Stock metrics",
              "Inventory summary",
            ]),
          })}
          catalog={[]}
          layout={layout}
          refreshKey={null}
          counterLive={false}
        />
      </PosHiddenContext.Provider>,
    );
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("999,999")).not.toBeInTheDocument();
    expect(screen.queryByText("Stale task")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Work queue unavailable",
    );
  });

  it("shows a widget-only failure without marking sales unavailable", () => {
    render(
      <PosHiddenContext.Provider value={false}>
        <OwnerDashboard
          data={ownerData({
            failedSections: new Set(["Inventory summary", "Stock metrics"]),
          })}
          catalog={[]}
          layout={layout}
          refreshKey={null}
          counterLive={false}
        />
      </PosHiddenContext.Provider>,
    );
    expect(screen.getByText("Couldn't load inventory health.")).toBeInTheDocument();
    expect(screen.queryAllByText("Unavailable")).toHaveLength(0);
  });
});