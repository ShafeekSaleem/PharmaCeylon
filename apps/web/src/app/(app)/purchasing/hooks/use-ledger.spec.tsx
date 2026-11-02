import { act, renderHook, waitFor } from "@testing-library/react";
import { useInvoices, useUnbilledDeliveries } from "./use-ledger";
import { apiJson } from "@/lib/auth-client";
let branchId = "a";
jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));
jest.mock("@/lib/use-auth", () => ({ useAuth: () => ({ branchId }) }));
beforeEach(() => {
  branchId = "a";
  (apiJson as jest.Mock).mockReset();
});
it("clears old branch invoices and ignores a late response after switching", async () => {
  let resolveFirst!: (rows: unknown) => void;
  (apiJson as jest.Mock)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    )
    .mockResolvedValueOnce([{ id: "b-invoice" }]);
  const view = renderHook(() => useInvoices({ supplierId: "supplier" }));
  branchId = "b";
  view.rerender();
  expect(view.result.current.rows).toEqual([]);
  await waitFor(() =>
    expect(view.result.current.rows).toEqual([{ id: "b-invoice" }]),
  );
  await act(async () => resolveFirst([{ id: "a-invoice" }]));
  expect(view.result.current.rows).toEqual([{ id: "b-invoice" }]);
});

it("keeps rows on screen through a search change, marking them stale until the answer lands", async () => {
  let resolveSearch!: (rows: unknown) => void;
  (apiJson as jest.Mock)
    .mockResolvedValueOnce([{ id: "first" }])
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSearch = resolve;
        }),
    );
  let q = "";
  const view = renderHook(() => useInvoices({ q }));
  await waitFor(() => expect(view.result.current.rows).toEqual([{ id: "first" }]));
  q = "INV";
  view.rerender();
  expect(view.result.current.rows).toEqual([{ id: "first" }]);
  expect(view.result.current.loading).toBe(false);
  expect(view.result.current.fresh).toBe(false);
  await act(async () => resolveSearch([{ id: "searched" }]));
  expect(view.result.current.rows).toEqual([{ id: "searched" }]);
  expect(view.result.current.fresh).toBe(true);
});

it("does not report loading for a list with nothing to load", async () => {
  const view = renderHook(() => useUnbilledDeliveries(null));
  await waitFor(() => expect(view.result.current.fresh).toBe(true));
  expect(view.result.current.loading).toBe(false);
  expect(apiJson).not.toHaveBeenCalled();
});
