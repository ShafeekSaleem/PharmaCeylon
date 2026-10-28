import { render, screen } from "@testing-library/react";
import type { DailyWorkItem, DailyWorkResponse } from "@pharmaceylon/shared";
import { useDailyWork } from "../hooks/use-daily-work";
import type { DashboardData } from "../hooks/use-dashboard-data";
import { CounterWaitingWidget } from "./counter-waiting";

jest.mock("../hooks/use-daily-work", () => ({ useDailyWork: jest.fn() }));
const mockedWork = jest.mocked(useDailyWork);

const item: DailyWorkItem = {
  id: "stocktake:1",
  kind: "stocktake.post",
  where: "counter",
  category: "stocktakes",
  title: "Post approved stocktake",
  detail: "Full count · Shelf A",
  reference: "ST-1",
  status: "approved",
  href: "/stocktakes/1",
  action: "View details",
  createdAt: "2026-10-28T04:00:00.000Z",
  dueAt: null,
  owner: "Branch reviewers",
  mine: false,
  approval: false,
  blocked: false,
  overdue: false,
  priority: 2,
};
const response = (overrides: Partial<DailyWorkResponse>): DailyWorkResponse => ({
  items: [item],
  total: 1,
  page: 1,
  pageSize: 6,
  counts: { all: 3, mine: 0, approvals: 0, overdue: 0, counter: 1 },
  categories: { stocktakes: 1 },
  asOf: "2026-10-28T05:12:00.000Z",
  timezone: "Asia/Colombo",
  branchName: "Colombo 03",
  counterLive: true,
  ...overrides,
});
const base = {
  error: null,
  loading: false,
  page: 1,
  filter: "counter" as const,
  category: "" as const,
  reload: jest.fn(),
  setPage: jest.fn(),
  selectFilter: jest.fn(),
  selectCategory: jest.fn(),
};
const data = { branchId: "branch-1", lastUpdatedAt: null } as unknown as DashboardData;

it("lists approved documents waiting at a live branch's counter, with when it was read", () => {
  mockedWork.mockReturnValue({ ...base, data: response({}) });
  render(<CounterWaitingWidget data={data} />);
  expect(mockedWork).toHaveBeenCalledWith("branch-1", null, "counter");
  expect(screen.getByText("1 job waits for someone at the counter.")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Post approved stocktake/ })).toHaveAttribute(
    "href",
    "/stocktakes/1",
  );
  // 05:12 UTC is 10:42 in Colombo.
  expect(screen.getByText("As of 10:42")).toBeInTheDocument();
});

it("explains that a not-live branch still does this work on the web", () => {
  mockedWork.mockReturnValue({
    ...base,
    data: response({ items: [], counterLive: false, counts: { all: 1, mine: 0, approvals: 0, overdue: 0, counter: 0 } }),
  });
  render(<CounterWaitingWidget data={data} />);
  expect(screen.getByText(/isn.t live on PharmaCeylon POS yet/)).toBeInTheDocument();
});

it("never shows an all-clear when the queue fails to load", () => {
  mockedWork.mockReturnValue({ ...base, data: null, error: "Connection lost" });
  render(<CounterWaitingWidget data={data} />);
  expect(screen.getByRole("alert")).toHaveTextContent("Connection lost");
  expect(screen.queryByText("Nothing is waiting at the counter.")).not.toBeInTheDocument();
});
