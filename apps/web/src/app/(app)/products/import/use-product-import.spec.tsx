import { act, renderHook, waitFor } from "@testing-library/react";
import { apiFetch, apiJson } from "@/lib/auth-client";
import { useProductImport } from "./use-product-import";

jest.mock("@/lib/auth-client", () => ({
  apiFetch: jest.fn(),
  apiJson: jest.fn(),
}));
let mockState: string | null = "not_live";
jest.mock("@/lib/branch-rollout", () => ({
  useBranchRollout: () => ({
    rollout: mockState ? { state: mockState } : null,
    loading: false,
  }),
}));
const api = jest.mocked(apiJson);

beforeEach(() => {
  api.mockResolvedValue([]);
  mockState = "not_live";
});
it.each([false, true])(
  "keeps catalog undo separate from legacy physical undo (stock=%s)",
  async (stockUndo) => {
    const { result } = renderHook(() => useProductImport());
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/products/import/history?take=10"),
    );
    api.mockClear();
    await act(async () => result.current.undo("saved-import", stockUndo));
    expect(api).toHaveBeenNthCalledWith(
      1,
      `/products/import/saved-import/${stockUndo ? "undo-stock" : "undo"}`,
      { method: "POST" },
    );
    expect(api).toHaveBeenLastCalledWith("/products/import/history?take=10");
  },
);
it("retains refusal details and does not report a failed undo as completed", async () => {
  const { result } = renderHook(() => useProductImport());
  await waitFor(() => expect(api).toHaveBeenCalled());
  api.mockRejectedValueOnce(new Error("Undo posted stock at the counter."));
  await act(async () => result.current.undo("saved-import", true));
  expect(result.current.error).toBe("Undo posted stock at the counter.");
  expect(result.current.busy).toBe(false);
});

it.each(["not_live", "live", "fallback", null])(
  "uses management staging except for known legacy branches: %s",
  async (state) => {
    mockState = state;
    const fetch = jest.mocked(apiFetch);
    fetch.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ suggestedMapping: { name: "Name" } }),
    } as Response);
    const { result, unmount } = renderHook(() => useProductImport());
    await act(async () =>
      result.current.chooseFile(new File(["Name\nPanadol"], "products.csv")),
    );
    fetch.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ jobId: "job", importId: "import" }),
    } as Response);
    api.mockResolvedValueOnce({ status: "completed", result: {} });
    await act(async () => result.current.runImport());
    expect(fetch).toHaveBeenLastCalledWith(
      state === "not_live"
        ? "/products/import/confirm"
        : "/products/import/stage",
      expect.any(Object),
    );
    unmount();
  },
);
it("honors an explicit opening-stock staging journey even at a not-live branch", async () => {
  const fetch = jest.mocked(apiFetch);
  fetch.mockResolvedValueOnce({
    ok: true,
    text: async () =>
      JSON.stringify({ suggestedMapping: { name: "Name", qty: "Qty" } }),
  } as Response);
  const { result, unmount } = renderHook(() => useProductImport(true));
  await act(async () =>
    result.current.chooseFile(new File(["Name,Qty\nPanadol,10"], "stock.csv")),
  );
  fetch.mockResolvedValueOnce({
    ok: true,
    text: async () => JSON.stringify({ jobId: "job", importId: "import" }),
  } as Response);
  api.mockResolvedValueOnce({ status: "completed", result: {} });
  await act(async () => result.current.runImport());
  expect(result.current.stagesStock).toBe(true);
  expect(fetch).toHaveBeenLastCalledWith(
    "/products/import/stage",
    expect.any(Object),
  );
  unmount();
});
