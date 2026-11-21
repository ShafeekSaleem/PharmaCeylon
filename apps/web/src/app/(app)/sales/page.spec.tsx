import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import SalesHistory from "./sales-history";
import { apiJson } from "@/lib/auth-client";
import { salesHistoryQuery } from "./services/sales-api";
import type { SaleListRow, SalesFilters, SalesHistoryPage } from "./types";
import { DEFAULT_FILTERS } from "./constants";
import { registersForPicker } from "./register-options";

let branchId: string | null = "branch-a";
const push = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));
jest.mock("@/lib/use-auth", () => ({ useAuth: () => ({ branchId }) }));

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
    register: { id: "reg-1", tillId: "till-1", label: "Counter 1 Floor 2" },
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
  branches: [
    { id: "branch-a", name: "Colombo" },
    { id: "branch-b", name: "Kandy" },
  ],
  sellers: [{ id: "user-cashier", fullName: "Nimal Perera" }],
  registers: [
    { registerId: "reg-1", tillId: "till-1", label: "Counter 1 Floor 2", branchId: "branch-a" },
    { registerId: "reg-2", tillId: "till-2", label: "Counter 1", branchId: "branch-b" },
  ],
  terminals: [
    { terminalId: "term-1", label: "Front desk", branchId: "branch-a" },
    { terminalId: "term-2", label: "Front desk", branchId: "branch-b" },
  ],
  shifts: [
    {
      shiftId: "shift-a",
      shiftNumber: "S-1",
      branchId: "branch-a",
      registerId: "reg-1",
      registerLabel: "Counter 1 Floor 2",
      openedAt: "2026-10-20T08:14:00.000Z",
      closedAt: null,
    },
    {
      shiftId: "shift-b",
      shiftNumber: "S-2",
      branchId: "branch-b",
      registerId: "reg-2",
      registerLabel: "Counter 1",
      openedAt: "2026-10-20T09:00:00.000Z",
      closedAt: null,
    },
  ],
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

function lastListHistoryQuery(): URLSearchParams {
  const listCalls = historyCalls().filter(
    (path) => new URLSearchParams(path.split("?")[1]).get("pageSize") === "25",
  );
  return new URLSearchParams(listCalls[listCalls.length - 1]!.split("?")[1]);
}

beforeEach(() => {
  branchId = "branch-a";
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
  expect(screen.getByText("Counter 1 Floor 2")).toBeInTheDocument();
  expect(screen.queryByText("Till 1")).not.toBeInTheDocument();
  expect(screen.getAllByText("Desktop").length).toBeGreaterThan(0);
  expect(screen.getByText("LKR 1,250.00")).toBeInTheDocument();
  expect(screen.getByText("Completed")).toBeInTheDocument();
  expect(screen.getAllByTestId("filter-chip-count")[0]).toHaveTextContent("3");

  const query = lastListHistoryQuery();
  expect(query.get("page")).toBe("1");
  expect(query.get("pageSize")).toBe("25");
  expect(query.has("branchId")).toBe(false);
});

it("only offers shifts from the active branch", async () => {
  render(<SalesHistory />);
  await screen.findByText("INV-2610-000042");

  fireEvent.click(screen.getByRole("button", { name: "Filters" }));
  fireEvent.click(screen.getByRole("button", { name: /^Shift/ }));
  expect(screen.getByRole("option", { name: /Counter 1 Floor 2 · S-1/ })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: /Counter 1 · S-2/ })).not.toBeInTheDocument();
});

it("only offers counters from the active branch", async () => {
  render(<SalesHistory />);
  await screen.findByText("INV-2610-000042");

  fireEvent.click(screen.getByRole("button", { name: /^Counter scope/ }));
  expect(screen.getByRole("option", { name: "Counter 1 Floor 2" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "Counter 1" })).not.toBeInTheDocument();
});

it("scopes register picks to the active branch", () => {
  const picks = registersForPicker(OPTIONS.registers, "branch-a", OPTIONS.branches);
  expect(picks.map((p) => p.counterLabel)).toEqual(["Counter 1 Floor 2"]);
});

it("shows branch suffix on counter options when no branch is selected", async () => {
  branchId = null;
  render(<SalesHistory />);
  await screen.findByText("INV-2610-000042");

  fireEvent.click(screen.getByRole("button", { name: /^Counter scope/ }));
  expect(screen.getByRole("option", { name: "Counter 1 Floor 2 · Colombo" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "Counter 1 · Kandy" })).toBeInTheDocument();
});

it("resets branch-scoped filters when the branch changes", async () => {
  const { rerender } = render(<SalesHistory />);
  await screen.findByText("INV-2610-000042");

  fireEvent.click(screen.getByRole("button", { name: "Filters" }));
  const panel = await screen.findByRole("dialog", { name: "Sales filters" });
  fireEvent.click(within(panel).getByRole("button", { name: /^Counter/ }));
  fireEvent.click(await screen.findByRole("option", { name: "Counter 1 Floor 2" }));
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await waitFor(() => expect(lastHistoryQuery().get("registerId")).toBe("reg-1"));

  branchId = "branch-b";
  rerender(<SalesHistory />);
  await waitFor(() => {
    const query = lastHistoryQuery();
    expect(query.has("registerId")).toBe(false);
    expect(query.has("shiftId")).toBe(false);
  });
});

it("asks the server for the next page", async () => {
  historyPages = [
    { items: [row()], total: 60, page: 1, pageSize: 25 },
    { items: [row({ id: "sale-26", invoiceNo: "INV-2610-000026" })], total: 60, page: 2, pageSize: 25 },
  ];
  render(<SalesHistory />);
  await screen.findByText("INV-2610-000042");

  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(await screen.findByText("INV-2610-000026")).toBeInTheDocument();
  expect(lastHistoryQuery().get("page")).toBe("2");
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
    fireEvent.click(await screen.findByRole("option", { name: "Counter 1 Floor 2" }));

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

it("shows the API error without empty-state copy", async () => {
  jest.mocked(apiJson).mockImplementation(async (path: string) => {
    if (path === "/sales/history/options") return OPTIONS;
    throw new Error("You can't view sales at that branch");
  });
  render(<SalesHistory />);
  expect(await screen.findByText("You can't view sales at that branch")).toBeInTheDocument();
  expect(screen.queryByText("No sales yet")).not.toBeInTheDocument();
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
        offlineSyncState: "held",
      },
      2,
    ),
  );
  expect(query.get("channel")).toBe("desktop_online");
  expect(query.get("registerId")).toBe("reg-1");
  expect(query.get("invoiceNo")).toBe("186");
  expect(query.get("soldBy")).toBe("user-cashier");
  expect(query.get("shiftId")).toBe("shift-1");
  expect(query.get("offlineSyncState")).toBe("held");
  expect(query.get("page")).toBe("2");
});

it("applies the sync filter from the Filters panel", async () => {
  render(<SalesHistory />);
  await screen.findByText("INV-2610-000042");

  fireEvent.click(screen.getByRole("button", { name: "Filters" }));
  fireEvent.click(screen.getByRole("button", { name: /^Sync/ }));
  fireEvent.click(await screen.findByRole("option", { name: "Synced — stock pending" }));
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));

  await waitFor(() =>
    expect(lastHistoryQuery().get("offlineSyncState")).toBe("pending_stock_posting"),
  );
});

it("shows sync pills and full-text hovers on cut-off cells", async () => {
  historyPages = [
    {
      items: [
        row({
          sellerName: "Nimal Perera with a very long display name",
          paymentMethods: ["cash", "card", "mobile_wallet"],
          offlineSyncState: "accepted",
          shift: {
            id: "shift-2",
            shiftNumber: "S-0099",
            openedAt: "2026-10-20T02:30:00.000Z",
            closedAt: "2026-10-20T14:30:00.000Z",
          },
        }),
      ],
      total: 1,
      page: 1,
      pageSize: 25,
    },
  ];
  render(<SalesHistory />);
  await screen.findByText("Accepted");
  expect(screen.getByText("Completed")).toBeInTheDocument();
  expect(
    screen.getByText("Nimal Perera with a very long display name").getAttribute("data-tooltip"),
  ).toContain("Nimal Perera with a very long display name");
});

it("opens a sale from its row", async () => {
  render(<SalesHistory />);
  fireEvent.click(await screen.findByText("INV-2610-000042"));
  expect(push).toHaveBeenCalledWith("/sales/sale-1");
});

it("routes receipt copy from the row menu", async () => {
  render(<SalesHistory />);
  await screen.findByText("INV-2610-000042");
  fireEvent.click(screen.getByRole("button", { name: /Actions for INV-2610-000042/ }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Receipt copy" }));
  expect(push).toHaveBeenCalledWith("/sales/sale-1?receipt=1");
});
