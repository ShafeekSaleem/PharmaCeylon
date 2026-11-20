import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SalesHistory from "./sales-history";
import { apiJson } from "@/lib/auth-client";
import { salesHistoryQuery } from "./services/sales-api";
import type { SaleListRow, SalesFilters, SalesHistoryPage } from "./types";
import { DEFAULT_FILTERS } from "./constants";

const push = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));
jest.mock("@/lib/use-auth", () => ({ useAuth: () => ({ branchId: "branch-a" }) }));

function row(overrides: Partial<SaleListRow> = {}): SaleListRow {
  return {
    id: "sale-1",
    invoiceNo: "INV-2610-000042",
    status: "posted",
    soldAt: "2026-10-20T04:00:00.000Z",
    grandTotal: "1250.00",
    branch: { id: "branch-a", name: "Colombo" },
    itemCount: 3,
    customerName: "Kamala Silva",
    sellerName: "Nimal Perera",
    paymentMethods: ["cash", "card"],
    summary: "2× Paracetamol, 1× Cetirizine",
    channel: "desktop_online",
    terminal: { id: "term-1", label: "Front desk" },
    register: { id: "reg-1", tillId: "till-1", label: "Counter 1" },
    shift: {
      id: "shift-1",
      shiftNumber: "S-0042",
      openedAt: "2026-10-20T08:14:00.000Z",
      closedAt: null,
    },
    ...overrides,
  };
}

const OPTIONS = {
  branches: [{ id: "branch-a", name: "Colombo" }],
  sellers: [{ id: "user-cashier", fullName: "Nimal Perera" }],
  registers: [{ registerId: "reg-1", tillId: "till-1", label: "Counter 1", branchId: "branch-a" }],
  terminals: [{ terminalId: "term-1", label: "Front desk", branchId: "branch-a" }],
};

let historyPages: SalesHistoryPage[];
let channelTotals: Record<string, number>;

function historyCalls(): string[] {
  return jest
    .mocked(apiJson)
    .mock.calls.map(([path]) => String(path))
    .filter((path) => path.startsWith("/sales/history?"));
}

function lastHistoryQuery(): URLSearchParams {
  const calls = historyCalls();
  return new URLSearchParams(calls[calls.length - 1]!.split("?")[1]);
}

beforeEach(() => {
  push.mockReset();
  historyPages = [];
  channelTotals = { all: 3, desktop_online: 2, offline: 1, web_legacy: 0, fallback: 0 };
  jest.mocked(apiJson).mockImplementation(async (path: string) => {
    if (path === "/sales/history/options") return OPTIONS;
    if (path.startsWith("/sales/history?")) {
      const query = new URLSearchParams(path.split("?")[1]);
      if (query.get("pageSize") === "1") {
        const channel = query.get("channel") ?? "all";
        const total = channelTotals[channel] ?? channelTotals.all ?? 0;
        return { items: [], total, page: 1, pageSize: 1 };
      }
      return historyPages.shift() ?? { items: [row()], total: 1, page: 1, pageSize: 25 };
    }
    throw new Error(`Unexpected request ${path}`);
  });
});

it("lists sales with Phase B columns and channel chip counts", async () => {
  render(<SalesHistory />);

  expect(await screen.findByText("INV-2610-000042")).toBeInTheDocument();
  expect(screen.getByText("Counter 1")).toBeInTheDocument();
  expect(screen.getByText("Till 1")).toBeInTheDocument();
  expect(screen.getAllByText("Desktop").length).toBeGreaterThan(0);
  expect(screen.getByText("Cash + Card")).toBeInTheDocument();
  expect(screen.getByText("LKR 1,250.00")).toBeInTheDocument();
  expect(screen.queryByText("Completed")).not.toBeInTheDocument();
  expect(screen.getAllByTestId("filter-chip-count")[0]).toHaveTextContent("3");
});

it("maps channel chip selection to the channel query param", async () => {
  render(<SalesHistory />);
  await screen.findByText("INV-2610-000042");

  fireEvent.click(screen.getByRole("button", { name: /Offline/i }));

  await waitFor(() => expect(lastHistoryQuery().get("channel")).toBe("offline"));
});

it("applies and clears Filters panel values", async () => {
  render(<SalesHistory />);
  await screen.findByText("INV-2610-000042");

  fireEvent.click(screen.getByRole("button", { name: "Filters" }));
  fireEvent.click(screen.getByRole("button", { name: /^Payment/ }));
  fireEvent.click(await screen.findByRole("option", { name: "Cash" }));
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));

  await waitFor(() => expect(lastHistoryQuery().get("paymentMethod")).toBe("cash"));

  fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
  await waitFor(() => expect(lastHistoryQuery().has("paymentMethod")).toBe(false));
});

it("searches by receipt with counter scope once typing pauses", async () => {
  jest.useFakeTimers();
  try {
    render(<SalesHistory />);
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: /^Counter scope/ }));
    fireEvent.click(await screen.findByRole("option", { name: "Counter 1" }));

    fireEvent.change(screen.getByRole("searchbox", { name: "Search by receipt or invoice number" }), {
      target: { value: "186" },
    });

    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    await waitFor(() => {
      const query = lastHistoryQuery();
      expect(query.get("invoiceNo")).toBe("186");
      expect(query.get("registerId")).toBe("reg-1");
    });
  } finally {
    jest.useRealTimers();
  }
});

it("shows the empty state when the branch has no sales", async () => {
  historyPages = [{ items: [], total: 0, page: 1, pageSize: 25 }];
  render(<SalesHistory />);
  expect(await screen.findByText("No sales yet")).toBeInTheDocument();
});

it("shows no-results when filters match nothing", async () => {
  historyPages = [
    { items: [row()], total: 1, page: 1, pageSize: 25 },
    { items: [], total: 0, page: 1, pageSize: 25 },
  ];
  render(<SalesHistory />);
  await screen.findByText("INV-2610-000042");
  fireEvent.click(screen.getByRole("button", { name: /Offline/i }));
  expect(await screen.findByText("No sales match these filters")).toBeInTheDocument();
});

it("shows loading status text while sales load", async () => {
  let resolveHistory: (value: SalesHistoryPage) => void = () => {};
  jest.mocked(apiJson).mockImplementation((path: string) => {
    if (path === "/sales/history/options") return Promise.resolve(OPTIONS);
    if (path.startsWith("/sales/history?") && new URLSearchParams(path.split("?")[1]).get("pageSize") !== "1") {
      return new Promise<SalesHistoryPage>((resolve) => {
        resolveHistory = resolve;
      });
    }
    if (path.startsWith("/sales/history?")) {
      return Promise.resolve({ items: [], total: 0, page: 1, pageSize: 1 });
    }
    return Promise.reject(new Error(`Unexpected ${path}`));
  });
  render(<SalesHistory />);
  expect(screen.getByText("Loading sales…")).toBeInTheDocument();
  await act(async () => {
    resolveHistory({ items: [row()], total: 1, page: 1, pageSize: 25 });
  });
  expect(await screen.findByText("INV-2610-000042")).toBeInTheDocument();
});

it("shows the API error", async () => {
  jest.mocked(apiJson).mockImplementation(async (path: string) => {
    if (path === "/sales/history/options") return OPTIONS;
    throw new Error("You can't view sales at that branch");
  });
  render(<SalesHistory />);
  expect(await screen.findByText("You can't view sales at that branch")).toBeInTheDocument();
});

it("maps filters to query params", () => {
  const query = new URLSearchParams(
    salesHistoryQuery(
      {
        ...DEFAULT_FILTERS,
        channel: "desktop_online",
        registerId: "reg-1",
        invoiceNo: "186",
        receiptCounterScope: "any",
        soldBy: "user-cashier",
        paymentMethod: "cash",
        shiftId: "shift-1",
      },
      2,
    ),
  );
  expect(query.get("channel")).toBe("desktop_online");
  expect(query.get("registerId")).toBe("reg-1");
  expect(query.get("invoiceNo")).toBe("186");
  expect(query.get("soldBy")).toBe("user-cashier");
  expect(query.get("shiftId")).toBe("shift-1");
  expect(query.get("page")).toBe("2");
});

it("opens a sale from its row", async () => {
  render(<SalesHistory />);
  fireEvent.click(await screen.findByText("INV-2610-000042"));
  expect(push).toHaveBeenCalledWith("/sales/sale-1");
});