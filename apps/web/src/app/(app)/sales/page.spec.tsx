import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import SalesPage from "./page";
import { apiJson } from "@/lib/auth-client";
import type { SaleListRow, SalesHistoryPage } from "./types";

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
    ...overrides,
  };
}

const OPTIONS = {
  branches: [
    { id: "branch-a", name: "Colombo" },
    { id: "branch-b", name: "Kandy" },
  ],
  sellers: [{ id: "user-cashier", fullName: "Nimal Perera" }],
};

let historyPages: SalesHistoryPage[];

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
  jest.mocked(apiJson).mockImplementation(async (path: string) => {
    if (path === "/sales/history/options") return OPTIONS;
    if (path.startsWith("/sales/history?")) {
      return historyPages.shift() ?? { items: [row()], total: 1, page: 1, pageSize: 25 };
    }
    throw new Error(`Unexpected request ${path}`);
  });
});

it("lists the active branch's sales, paged on the server", async () => {
  render(<SalesPage />);

  expect(await screen.findByText("INV-2610-000042")).toBeInTheDocument();
  expect(screen.getByText("2× Paracetamol, 1× Cetirizine")).toBeInTheDocument();
  expect(screen.getByText("Kamala Silva")).toBeInTheDocument();
  expect(screen.getByText("Cash + Card")).toBeInTheDocument();
  expect(screen.getByText("LKR 1,250.00")).toBeInTheDocument();
  expect(screen.getByText("Completed")).toBeInTheDocument();

  const query = lastHistoryQuery();
  expect(query.get("page")).toBe("1");
  expect(query.get("pageSize")).toBe("25");
  // The active branch comes from the request header, not a query parameter.
  expect(query.has("branchId")).toBe(false);
  // One branch in view: no Branch column.
  expect(screen.queryByRole("columnheader", { name: "Branch" })).not.toBeInTheDocument();
});

it("asks the server for the next page", async () => {
  historyPages = [
    { items: [row()], total: 60, page: 1, pageSize: 25 },
    { items: [row({ id: "sale-26", invoiceNo: "INV-2610-000026" })], total: 60, page: 2, pageSize: 25 },
  ];
  render(<SalesPage />);
  await screen.findByText("INV-2610-000042");

  fireEvent.click(screen.getByRole("button", { name: "Next" }));

  expect(await screen.findByText("INV-2610-000026")).toBeInTheDocument();
  expect(lastHistoryQuery().get("page")).toBe("2");
});

it("widens to every viewable branch and shows which branch each sale was at", async () => {
  render(<SalesPage />);
  await screen.findByText("INV-2610-000042");

  fireEvent.click(screen.getByRole("button", { name: /^Branch/ }));
  fireEvent.click(await screen.findByRole("option", { name: "All my branches" }));

  await waitFor(() => expect(lastHistoryQuery().get("branchId")).toBe("all"));
  expect(await screen.findByRole("columnheader", { name: "Branch" })).toBeInTheDocument();
});

it("filters by staff, payment method and today's date", async () => {
  render(<SalesPage />);
  await screen.findByText("INV-2610-000042");

  fireEvent.click(screen.getByRole("button", { name: /^Staff/ }));
  fireEvent.click(within(await screen.findByRole("listbox", { name: "Staff" })).getByRole("option", { name: "Nimal Perera" }));
  await waitFor(() => expect(lastHistoryQuery().get("soldBy")).toBe("user-cashier"));

  fireEvent.click(screen.getByRole("button", { name: /^Payment/ }));
  fireEvent.click(await screen.findByRole("option", { name: "Mobile wallet" }));
  await waitFor(() => expect(lastHistoryQuery().get("paymentMethod")).toBe("mobile_wallet"));

  fireEvent.click(screen.getByRole("button", { name: "Today" }));
  await waitFor(() => {
    const query = lastHistoryQuery();
    expect(query.get("from")).toBeTruthy();
    expect(query.get("from")).toBe(query.get("to"));
  });
  expect(screen.getByRole("button", { name: "Today" })).toHaveAttribute("aria-pressed", "true");

  fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
  await waitFor(() => {
    const query = lastHistoryQuery();
    expect(query.has("soldBy")).toBe(false);
    expect(query.has("paymentMethod")).toBe(false);
    expect(query.has("from")).toBe(false);
  });
});

it("searches by invoice number once typing pauses", async () => {
  jest.useFakeTimers();
  try {
    render(<SalesPage />);
    await act(async () => {
      await Promise.resolve();
    });
    const before = historyCalls().length;

    fireEvent.change(screen.getByRole("searchbox", { name: "Search by invoice number" }), {
      target: { value: "0042" },
    });
    expect(historyCalls().length).toBe(before);

    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    expect(lastHistoryQuery().get("invoiceNo")).toBe("0042");
  } finally {
    jest.useRealTimers();
  }
});

it("opens a sale's detail from its row", async () => {
  render(<SalesPage />);

  fireEvent.click(await screen.findByText("INV-2610-000042"));

  expect(push).toHaveBeenCalledWith("/sales/sale-1");
});

it("says so when no sale matches", async () => {
  historyPages = [
    { items: [row()], total: 1, page: 1, pageSize: 25 },
    { items: [], total: 0, page: 1, pageSize: 25 },
  ];
  render(<SalesPage />);
  await screen.findByText("INV-2610-000042");

  fireEvent.click(screen.getByRole("button", { name: /^Payment/ }));
  fireEvent.click(await screen.findByRole("option", { name: "Credit" }));

  expect(await screen.findByText("No sales match these filters")).toBeInTheDocument();
});

it("shows the API's refusal", async () => {
  jest.mocked(apiJson).mockImplementation(async (path: string) => {
    if (path === "/sales/history/options") return OPTIONS;
    throw new Error("You can't view sales at that branch");
  });
  render(<SalesPage />);

  expect(await screen.findByText("You can't view sales at that branch")).toBeInTheDocument();
});
