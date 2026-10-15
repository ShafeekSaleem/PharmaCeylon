import { render, screen } from "@testing-library/react";
import { DailyWorkQueue, workTiming } from "./daily-work-queue";
import { useDailyWork } from "../hooks/use-daily-work";
import type { DailyWorkItem } from "@pharmaceylon/shared";

jest.mock("@/lib/permissions", () => ({
  usePermissions: () => ({ permissionKeys: ["sales.pos_use"] }),
}));
jest.mock("../hooks/use-daily-work", () => ({ useDailyWork: jest.fn() }));
const mockedWork = jest.mocked(useDailyWork);
const item: DailyWorkItem = {
  id: "hold:1",
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
      counts: { all: 1, mine: 0, overdue: 0, approvals: 0 },
      categories: { counter: 1 },
      asOf: "2026-10-15T20:00:00Z",
      timezone: "Asia/Colombo",
      branchName: "Main",
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
