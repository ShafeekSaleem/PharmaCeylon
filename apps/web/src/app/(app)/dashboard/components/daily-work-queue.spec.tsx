import { render, screen } from "@testing-library/react";
import { DailyWorkQueue, workTiming } from "./daily-work-queue";
import { PosHiddenContext } from "../lib/pos-links";
import { useDailyWork } from "../hooks/use-daily-work";
import type { DailyWorkItem } from "@pharmaceylon/shared";

jest.mock("@/lib/permissions", () => ({
  usePermissions: () => ({ permissionKeys: ["sales.pos_use"] }),
}));
jest.mock("../hooks/use-daily-work", () => ({ useDailyWork: jest.fn() }));
const mockedWork = jest.mocked(useDailyWork);
const item: DailyWorkItem = {
  id: "hold:1",
  kind: "held_sale.pharmacist_review",
  where: "web",
  category: "counter",
  title: "Pharmacist review requested",
  detail: "Held bill · 3 items",
  reference: "HOLD-1",
  status: "needs_review",
  href: "/pos?panel=holds&holdId=1",
  action: "Review hold",
  createdAt: "2026-10-15T19:00:00Z",
  dueAt: null,
  owner: "Cashier",
  mine: false,
  approval: false,
  blocked: false,
  overdue: false,
  priority: 1,
};
const base = {
  data: null,
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

it("never shows all-clear or stale actions when a queue request fails", () => {
  mockedWork.mockReturnValue({
    ...base,
    error: "Connection lost",
    data: {
      items: [item],
      total: 1,
      page: 1,
      pageSize: 6,
      counts: { all: 1, mine: 0, overdue: 0, approvals: 0, counter: 0 },
      categories: { counter: 1 },
      asOf: "2026-10-15T20:00:00Z",
      timezone: "Asia/Colombo",
      branchName: "Main",
      counterLive: false,
    },
  });
  render(<DailyWorkQueue role="cashier" branchId="branch" refreshKey={null} />);
  expect(screen.getByRole("alert")).toHaveTextContent("Work queue unavailable");
  expect(screen.queryByText("You’re up to date")).not.toBeInTheDocument();
  expect(screen.queryByText("Review hold")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Open POS/ })).toHaveAttribute(
    "href",
    "/pos",
  );
});

it("shows a hold's waiting time without deriving a Ready status", () => {
  expect(workTiming(item, "Asia/Colombo", "2026-10-15T19:03:00Z")).toBe(
    "3 min waiting",
  );
});

it("formats inclusive expiry deadlines in their business timezone", () => {
  expect(
    workTiming(
      { ...item, category: "inventory", dueAt: "2026-10-15T18:29:59.999Z" },
      "Asia/Colombo",
      "2026-10-15T10:00:00Z",
    ),
  ).toBe("Due 15 Oct");
});

const counterItem: DailyWorkItem = {
  ...item,
  id: "adjustment:1",
  kind: "held_adjustment.post",
  where: "counter",
  category: "inventory",
  title: "Post approved write-off",
  reference: "B-12",
  status: "approved",
  href: "/inventory?heldAdjustment=1",
  action: "View details",
};
const liveData = {
  items: [counterItem, item],
  total: 2,
  page: 1,
  pageSize: 6,
  counts: { all: 2, mine: 0, overdue: 0, approvals: 0, counter: 1 },
  categories: { inventory: 1, counter: 1 },
  asOf: "2026-10-15T20:00:00Z",
  timezone: "Asia/Colombo",
  branchName: "Main",
  counterLive: true,
};

it("marks counter work and offers the counter filter at a live branch, without /pos links", () => {
  mockedWork.mockReturnValue({ ...base, data: liveData });
  const { container } = render(
    <PosHiddenContext.Provider value>
      <DailyWorkQueue role="cashier" branchId="branch" refreshKey={null} />
    </PosHiddenContext.Provider>,
  );
  expect(screen.getByText("At the counter", { selector: "span" })).toBeInTheDocument();
  expect(screen.getByText("Done in PharmaCeylon POS at Main.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /At the counter/ })).toHaveTextContent("1");
  expect(screen.getByRole("link", { name: "View details: B-12" })).toHaveAttribute(
    "href",
    "/inventory?heldAdjustment=1",
  );
  expect(container.querySelector('a[href^="/pos"]')).toBeNull();
});

it("keeps the counter filter away at a not-live branch", () => {
  mockedWork.mockReturnValue({
    ...base,
    data: { ...liveData, items: [item], counterLive: false },
  });
  render(<DailyWorkQueue role="cashier" branchId="branch" refreshKey={null} />);
  expect(screen.queryByRole("button", { name: /At the counter/ })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Review hold: HOLD-1" })).toHaveAttribute(
    "href",
    "/pos?panel=holds&holdId=1",
  );
});
