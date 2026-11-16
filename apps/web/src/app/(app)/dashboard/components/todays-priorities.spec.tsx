import { render, screen, fireEvent } from "@testing-library/react";
import { TodaysPriorities } from "./todays-priorities";
import { useDailyWork } from "../hooks/use-daily-work";
import { usePriorityStock } from "../hooks/use-priority-stock";
import { WORK_PAGE_SIZE } from "../lib/fixed-layout";
import type { DashboardData } from "../hooks/use-dashboard-data";

jest.mock("../hooks/use-daily-work", () => ({ useDailyWork: jest.fn() }));
jest.mock("../hooks/use-priority-stock", () => ({ usePriorityStock: jest.fn() }));
jest.mock("../lib/pos-links", () => ({
  usePosHidden: () => false,
  dashboardHref: (href: string) => href,
}));

const mockedWork = jest.mocked(useDailyWork);
const mockedStock = jest.mocked(usePriorityStock);

const data = {
  branchId: "branch-1",
  branchName: "Main",
  purchaseOrders: [],
  overduePos: 2,
  nearExpiryCount: 3,
  controlledAttentionCount: 1,
  ownerLowStock: 5,
  inventory: { lowStock: 5, outOfStock: 4 },
} as unknown as DashboardData;

const workBase = {
  data: {
    items: [],
    total: 0,
    page: 1,
    pageSize: WORK_PAGE_SIZE,
    counts: { all: 0, mine: 0, approvals: 0, overdue: 0, counter: 0 },
    categories: {},
    asOf: "2026-11-16T12:00:00Z",
    timezone: "Asia/Colombo",
    branchName: "Main",
    counterLive: false,
  },
  error: null,
  loading: false,
  page: 1,
  filter: "all" as const,
  category: "" as const,
  reload: jest.fn(),
  setPage: jest.fn(),
  selectFilter: jest.fn(),
  selectCategory: jest.fn(),
};

beforeEach(() => {
  mockedWork.mockReturnValue(workBase);
  mockedStock.mockReturnValue({
    low: [],
    out: [],
    controlledLow: [],
    nearExpiry: [],
    loading: false,
    error: null,
  });
});

it("requests work with page size 8", () => {
  render(
    <TodaysPriorities data={data} refreshKey={null} counterLive={false} />,
  );
  expect(mockedWork).toHaveBeenCalledWith(
    "branch-1",
    null,
    "all",
    WORK_PAGE_SIZE,
  );
});

it("renders horizontally scrolling filter chips with tone pills", () => {
  mockedWork.mockReturnValue({
    ...workBase,
    data: {
      ...workBase.data!,
      counts: { all: 4, mine: 0, approvals: 1, overdue: 0, counter: 0 },
    },
  });
  const { container } = render(
    <TodaysPriorities
      data={data}
      refreshKey={null}
      counterLive={false}
      showManagerStockChips
    />,
  );
  const tablist = screen.getByRole("tablist", {
    name: /Filter today's priorities/i,
  });
  expect(tablist.className).toMatch(/chips/);
  expect(tablist).toHaveAttribute("role", "tablist");
  const selected = screen.getByRole("tab", { name: /All/i });
  expect(selected).toHaveAttribute("aria-selected", "true");
  expect(container.querySelector('[class*="statusPillActive"]')).toBeTruthy();
  expect(screen.queryByRole("tab", { name: /Assigned to me/i })).toBeNull();
});

it("shows empty-state copy from the v6 mockup", () => {
  render(
    <TodaysPriorities data={data} refreshKey={null} counterLive={false} />,
  );
  expect(screen.getByText("You're up to date")).toBeInTheDocument();
});

it("shows offline work-queue copy", () => {
  mockedWork.mockReturnValue({
    ...workBase,
    error: "Network error",
    data: null,
  });
  render(
    <TodaysPriorities data={data} refreshKey={null} counterLive={false} />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent("Work queue unavailable");
  expect(screen.getByText(/Can't reach the server/i)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Try again/i }));
  expect(workBase.reload).toHaveBeenCalled();
});

it("shows loading skeleton rows", () => {
  mockedWork.mockReturnValue({ ...workBase, loading: true, data: null });
  render(
    <TodaysPriorities data={data} refreshKey={null} counterLive={false} />,
  );
  expect(screen.getByRole("status", { name: /Loading priorities/i })).toBeInTheDocument();
});