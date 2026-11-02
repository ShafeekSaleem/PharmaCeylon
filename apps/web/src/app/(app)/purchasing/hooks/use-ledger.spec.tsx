import { act, renderHook, waitFor } from "@testing-library/react";
import { useInvoices } from "./use-ledger";
import { apiJson } from "@/lib/auth-client";
let branchId = "a";
jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));
jest.mock("@/lib/use-auth", () => ({ useAuth: () => ({ branchId }) }));
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
