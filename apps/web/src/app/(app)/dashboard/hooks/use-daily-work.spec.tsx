import { act, renderHook, waitFor } from "@testing-library/react";
import { apiJson } from "@/lib/auth-client";
import { useDailyWork } from "./use-daily-work";
import type { DailyWorkResponse } from "@pharmaceylon/shared";

jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));
const request = jest.mocked(apiJson);
const result = (
  overrides: Partial<DailyWorkResponse> = {},
): DailyWorkResponse => ({
  items: [],
  total: 0,
  page: 1,
  pageSize: 6,
  counts: { all: 0, mine: 0, approvals: 0, overdue: 0, counter: 0 },
  categories: {},
  asOf: "2026-10-15T20:00:00Z",
  timezone: "Asia/Colombo",
  branchName: "Main",
  counterLive: false,
  ...overrides,
});

describe("daily-work request lifecycle", () => {
  beforeEach(() => request.mockReset());

  it("ignores an older branch response even when the transport does not honour abort", async () => {
    let finishA!: (value: DailyWorkResponse) => void;
    let finishB!: (value: DailyWorkResponse) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishA = resolve as typeof finishA;
        }),
    );
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishB = resolve as typeof finishB;
        }),
    );
    const hook = renderHook(({ branch }) => useDailyWork(branch, null), {
      initialProps: { branch: "A" },
    });
    hook.rerender({ branch: "B" });
    await act(async () => finishB(result({ branchName: "Branch B" })));
    await act(async () => finishA(result({ branchName: "Branch A" })));
    expect(hook.result.current.data?.branchName).toBe("Branch B");
    expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("requests filters and categories on the server and resets pagination", async () => {
    request.mockResolvedValue(result({ total: 30 }));
    const hook = renderHook(() => useDailyWork("branch", null));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    act(() => hook.result.current.setPage(3));
    await waitFor(() =>
      expect(request).toHaveBeenLastCalledWith(
        expect.stringContaining("page=3"),
        expect.anything(),
      ),
    );
    act(() => hook.result.current.selectFilter("mine"));
    await waitFor(() =>
      expect(request).toHaveBeenLastCalledWith(
        "/dashboard/work?filter=mine&page=1",
        expect.anything(),
      ),
    );
    act(() => hook.result.current.selectCategory("stocktakes"));
    await waitFor(() =>
      expect(request).toHaveBeenLastCalledWith(
        "/dashboard/work?filter=mine&page=1&category=stocktakes",
        expect.anything(),
      ),
    );
  });

  it("returns to the last valid page when completed tasks empty the current page", async () => {
    request.mockResolvedValueOnce(result({ total: 7 }));
    const hook = renderHook(() => useDailyWork("branch", null));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    request.mockResolvedValue(result({ total: 6 }));
    act(() => hook.result.current.setPage(2));
    await waitFor(() => expect(hook.result.current.page).toBe(1));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
  });

  it("keeps failure distinct from an empty queue and recovers on retry", async () => {
    request.mockRejectedValueOnce(new Error("Service unavailable"));
    const hook = renderHook(() => useDailyWork("branch", null));
    await waitFor(() =>
      expect(hook.result.current.error).toBe("Service unavailable"),
    );
    expect(hook.result.current.data).toBeNull();
    request.mockResolvedValueOnce(result());
    act(() => hook.result.current.reload());
    await waitFor(() => expect(hook.result.current.error).toBeNull());
    await waitFor(() => expect(hook.result.current.data?.total).toBe(0));
  });
});
