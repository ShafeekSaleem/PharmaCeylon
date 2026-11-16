import { render, screen, fireEvent, within } from "@testing-library/react";
import { TodaysPriorities } from "./todays-priorities";
import { useDailyWork } from "../hooks/use-daily-work";
import { usePriorityStock } from "../hooks/use-priority-stock";
import { WORK_PAGE_SIZE } from "../lib/fixed-layout";
import { PRIORITY_LIST_TAKE } from "../lib/priority-list-count";
import type { DashboardData } from "../hooks/use-dashboard-data";
import type { BatchRow, StockRow } from "@/app/(app)/inventory/types";
import type { PurchaseOrderListItem } from "@/app/(app)/purchasing/types";

jest.mock("../hooks/use-daily-work", () => ({ useDailyWork: jest.fn() }));
jest.mock("../hooks/use-priority-stock", () => ({
  usePriorityStock: jest.fn(),
  stockItemsForFilter: jest.requireActual("../hooks/use-priority-stock")
    .stockItemsForFilter,
  stockListForChipCount: jest.requireActual("../hooks/use-priority-stock")
    .stockListForChipCount,
}));

jest.mock("../lib/pos-links", () => ({
  usePosHidden: () => false,
  dashboardHref: (href: string) => href,
}));

const mockedWork = jest.mocked(useDailyWork);
const mockedStock = jest.mocked(usePriorityStock);

function stockRow(name: string, id = name): StockRow {
  return {
    productId: id,
    availableQty: 2,
    stockStatus: "low",
    product: {
      id,
      name,
      sku: id,
      unit: "tab",
    },
  } as StockRow;
}

function batchRow(name: string): BatchRow {
  return {
    id: name,
    batchNo: "B1",
    daysToExpiry: 5,
    product: { id: "p1", name, sku: "p1", isControlled: false },
  } as BatchRow;
}

const dataBase = {
  branchId: "branch-1",
  branchName: "Main",
  purchaseOrders: [] as PurchaseOrderListItem[],
  loading: false,
  failedSections: new Set<string>(),
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

const emptyStock = {
  low: [] as StockRow[],
  out: [] as StockRow[],
  controlledLow: [] as StockRow[],
  controlledOut: [] as StockRow[],
  nearExpiry: [] as BatchRow[],
  loading: false,
  error: null,
};

beforeEach(() => {
  mockedWork.mockReturnValue(workBase);
  mockedStock.mockReturnValue(emptyStock);
});

it("requests work with page size 8", () => {
  render(
    <TodaysPriorities data={dataBase} refreshKey={null} counterLive={false} />,
  );
  expect(mockedWork).toHaveBeenCalledWith(
    "branch-1",
    null,
    "all",
    WORK_PAGE_SIZE,
  );
});

it("disables stock fetch while the overdue deliveries filter is active", () => {
  const data = {
    ...dataBase,
    purchaseOrders: [
      {
        id: "po1",
        poNumber: "PO-1",
        expectedOn: "2020-01-01",
        status: "issued",
      },
    ],
  } as unknown as DashboardData;
  render(
    <TodaysPriorities data={data} refreshKey={null} showManagerStockChips />,
  );
  expect(mockedStock).toHaveBeenLastCalledWith("branch-1", null, true);
  fireEvent.click(screen.getByRole("tab", { name: /Overdue deliveries/i }));
  expect(mockedStock).toHaveBeenLastCalledWith("branch-1", null, false);
});

it("chip count N opens N stock rows", () => {
  const stock = Array.from({ length: 3 }, (_, i) => stockRow(`Prod ${i}`, `p${i}`));
  mockedStock.mockReturnValue({ ...emptyStock, low: stock });
  render(
    <TodaysPriorities
      data={dataBase}
      refreshKey={null}
      showManagerStockChips
    />,
  );
  const tab = screen.getByRole("tab", { name: /Low stock/i });
  expect(tab).toHaveTextContent("3");
  fireEvent.click(tab);
  const list = screen.getByRole("tab", { name: /Low stock/i }).closest("section")!;
  const rows = within(list).getAllByText(/^Prod /);
  expect(rows).toHaveLength(3);
  expect(screen.getByRole("status")).toHaveTextContent("1–3 of 3 items");
});

it("hides stock chips when their list count is zero", () => {
  mockedStock.mockReturnValue({
    ...emptyStock,
    low: [stockRow("Only low")],
  });
  render(
    <TodaysPriorities
      data={dataBase}
      refreshKey={null}
      showManagerStockChips
    />,
  );
  expect(screen.getByRole("tab", { name: /Low stock/i })).toBeInTheDocument();
  expect(screen.queryByRole("tab", { name: /Near expiry/i })).toBeNull();
  expect(screen.queryByRole("tab", { name: /Out of stock/i })).toBeNull();
});

it("shows 200+ on chip and footer when list hits take cap", () => {
  const stock = Array.from({ length: PRIORITY_LIST_TAKE }, (_, i) =>
    stockRow(`Row ${i}`, `id-${i}`),
  );
  mockedStock.mockReturnValue({ ...emptyStock, low: stock });
  render(
    <TodaysPriorities data={dataBase} refreshKey={null} showManagerStockChips />,
  );
  fireEvent.click(screen.getByRole("tab", { name: /Low stock/i }));
  expect(screen.getByRole("tab", { name: /Low stock/i })).toHaveTextContent(
    "200+",
  );
  expect(screen.getByRole("status")).toHaveTextContent(/of 200\+ items/);
});

it("paginates stock lists past 8 rows", () => {
  const stock = Array.from({ length: 10 }, (_, i) =>
    stockRow(`Item ${i}`, `x${i}`),
  );
  mockedStock.mockReturnValue({ ...emptyStock, low: stock });
  render(
    <TodaysPriorities data={dataBase} refreshKey={null} showManagerStockChips />,
  );
  fireEvent.click(screen.getByRole("tab", { name: /Low stock/i }));
  expect(screen.getAllByText(/^Item /)).toHaveLength(8);
  fireEvent.click(screen.getByRole("button", { name: /Next/i }));
  expect(screen.getAllByText(/^Item /)).toHaveLength(2);
});

it("shows stock list error copy on an active stock filter", () => {
  mockedStock.mockReturnValue({
    ...emptyStock,
    low: [stockRow("X")],
  });
  const { rerender } = render(
    <TodaysPriorities data={dataBase} refreshKey={null} showManagerStockChips />,
  );
  fireEvent.click(screen.getByRole("tab", { name: /Low stock/i }));
  mockedStock.mockReturnValue({
    ...emptyStock,
    low: [],
    error: "Couldn't load stock lists.",
  });
  rerender(
    <TodaysPriorities data={dataBase} refreshKey="reload" showManagerStockChips />,
  );
  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent("Stock lists unavailable");
  expect(alert).toHaveTextContent("Couldn't load stock lists.");
});

it("shows purchase-order error on the overdue filter when PO data failed", () => {
  const data = {
    ...dataBase,
    purchaseOrders: [
      {
        id: "po1",
        poNumber: "PO-1",
        expectedOn: "2020-01-01",
        status: "issued",
      },
    ],
  } as unknown as DashboardData;
  const { rerender } = render(
    <TodaysPriorities data={data} refreshKey={null} />,
  );
  fireEvent.click(screen.getByRole("tab", { name: /Overdue deliveries/i }));
  const failed = {
    ...dataBase,
    purchaseOrders: [],
    failedSections: new Set(["Purchase orders"]),
  } as unknown as DashboardData;
  rerender(<TodaysPriorities data={failed} refreshKey="r" />);
  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent("Purchase orders unavailable");
  expect(alert).toHaveTextContent("Couldn't load purchase orders.");
});

it("overdue deliveries ignores stock list errors", () => {
  const data = {
    ...dataBase,
    purchaseOrders: [
      {
        id: "po1",
        poNumber: "PO-1",
        expectedOn: "2020-01-01",
        status: "issued",
      },
    ],
  } as unknown as DashboardData;
  mockedStock.mockReturnValue({
    ...emptyStock,
    error: "Couldn't load stock lists.",
  });
  render(<TodaysPriorities data={data} refreshKey={null} />);
  fireEvent.click(screen.getByRole("tab", { name: /Overdue deliveries/i }));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("PO-1")).toBeInTheDocument();
});

it("resets filter to All when the selected chip count drops to zero", () => {
  const stock = [stockRow("One")];
  mockedStock.mockReturnValue({ ...emptyStock, low: stock });
  const { rerender } = render(
    <TodaysPriorities data={dataBase} refreshKey={null} showManagerStockChips />,
  );
  fireEvent.click(screen.getByRole("tab", { name: /Low stock/i }));
  expect(screen.getByRole("tab", { name: /Low stock/i })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  mockedStock.mockReturnValue({ ...emptyStock, low: [] });
  rerender(
    <TodaysPriorities
      data={dataBase}
      refreshKey="r1"
      showManagerStockChips
    />,
  );
  expect(screen.getByRole("tab", { name: /^All/i })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

it("matches overdue chip count to filtered purchase order rows", () => {
  const data = {
    ...dataBase,
    purchaseOrders: [
      {
        id: "po1",
        poNumber: "PO-1",
        expectedOn: "2020-01-01",
        status: "issued",
      },
      {
        id: "po2",
        poNumber: "PO-2",
        expectedOn: "2020-02-01",
        status: "partially_received",
      },
    ],
  } as unknown as DashboardData;
  render(<TodaysPriorities data={data} refreshKey={null} />);
  fireEvent.click(screen.getByRole("tab", { name: /Overdue deliveries/i }));
  expect(screen.getByText("PO-1")).toBeInTheDocument();
  expect(screen.getByText("PO-2")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("1–2 of 2 orders");
});

it("renders horizontally scrolling filter chips with tone pills", () => {
  mockedWork.mockReturnValue({
    ...workBase,
    data: {
      ...workBase.data!,
      counts: { all: 4, mine: 0, approvals: 1, overdue: 0, counter: 0 },
    },
  });
  mockedStock.mockReturnValue({
    ...emptyStock,
    low: [stockRow("L")],
    nearExpiry: [batchRow("Batchy")],
  });
  const { container } = render(
    <TodaysPriorities
      data={dataBase}
      refreshKey={null}
      counterLive={false}
      showManagerStockChips
    />,
  );
  const tablist = screen.getByRole("tablist", {
    name: /Filter today's priorities/i,
  });
  expect(tablist.className).toMatch(/chips/);
  const selected = screen.getByRole("tab", { name: /All/i });
  expect(selected).toHaveAttribute("aria-selected", "true");
  expect(container.querySelector('[class*="statusPillActive"]')).toBeTruthy();
});

it("shows empty-state copy from the v6 mockup", () => {
  render(
    <TodaysPriorities data={dataBase} refreshKey={null} counterLive={false} />,
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
    <TodaysPriorities data={dataBase} refreshKey={null} counterLive={false} />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent("Work queue unavailable");
  expect(screen.getByText(/Network error/i)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Try again/i }));
  expect(workBase.reload).toHaveBeenCalled();
});

it("shows loading skeleton rows", () => {
  mockedWork.mockReturnValue({ ...workBase, loading: true, data: null });
  render(
    <TodaysPriorities data={dataBase} refreshKey={null} counterLive={false} />,
  );
  expect(
    screen.getByRole("status", { name: /Loading priorities/i }),
  ).toBeInTheDocument();
});