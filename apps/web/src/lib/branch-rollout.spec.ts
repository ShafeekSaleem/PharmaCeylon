import { act, renderHook, waitFor } from "@testing-library/react";
import { apiJson } from "./auth-client";
import {
  currentRollout,
  notifyPosRolloutChanged,
  resetBranchRolloutCache,
  useBranchRollout,
  webPosHidden,
  type PosRollout,
} from "./branch-rollout";

jest.mock("./auth-client", () => ({
  apiJson: jest.fn(),
  BRANCHES_CHANGED_EVENT: "pharmaceylon-branches-changed",
}));
let mockBranchId = "b-1";
jest.mock("./use-auth", () => ({
  useAuth: () => ({ user: { id: "user-1" }, branchId: mockBranchId, ready: true }),
}));

const request = jest.mocked(apiJson);
const NOW = new Date("2026-10-27T10:00:00Z").getTime();

function fallbackUntil(endsAt: string): PosRollout {
  return {
    state: "fallback",
    liveSince: "2026-10-01T00:00:00Z",
    fallback: { startedAt: "2026-10-27T09:00:00Z", endsAt },
  };
}

describe("currentRollout", () => {
  it("passes through a state with no fallback, or nothing at all", () => {
    expect(currentRollout(null, NOW)).toBeNull();
    const live: PosRollout = { state: "live", liveSince: "2026-10-01T00:00:00Z", fallback: null };
    expect(currentRollout(live, NOW)).toBe(live);
  });

  it("keeps a fallback until it ends, then reads as live", () => {
    expect(currentRollout(fallbackUntil("2026-10-27T11:00:00Z"), NOW)?.state).toBe("fallback");
    expect(currentRollout(fallbackUntil("2026-10-27T10:00:00Z"), NOW)).toEqual({
      state: "live",
      liveSince: "2026-10-01T00:00:00Z",
      fallback: null,
    });
  });

  it("hides the web POS only when live without a fallback", () => {
    expect(webPosHidden(null)).toBe(false);
    expect(webPosHidden({ state: "not_live", liveSince: null, fallback: null })).toBe(false);
    expect(webPosHidden(fallbackUntil("2026-10-27T11:00:00Z"))).toBe(false);
    expect(webPosHidden({ state: "live", liveSince: null, fallback: null })).toBe(true);
  });
});

describe("useBranchRollout", () => {
  beforeEach(() => {
    resetBranchRolloutCache();
    request.mockReset();
    mockBranchId = "b-1";
  });
  afterEach(() => jest.useRealTimers());

  it("reads the selected branch's state from /tenant/context", async () => {
    request.mockResolvedValue({
      branchRoles: [
        { branchId: "b-1", branch: { posRollout: { state: "live", liveSince: null, fallback: null } } },
        { branchId: "b-2", branch: { posRollout: { state: "not_live", liveSince: null, fallback: null } } },
      ],
    } as never);
    const hook = renderHook(() => useBranchRollout());
    expect(hook.result.current.rollout).toBeNull();
    await waitFor(() => expect(hook.result.current.rollout?.state).toBe("live"));
    expect(request).toHaveBeenCalledWith("/tenant/context");

    mockBranchId = "b-2";
    hook.rerender();
    expect(hook.result.current.rollout?.state).toBe("not_live");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("is null for a branch the context doesn't describe", async () => {
    request.mockResolvedValue({ branchRoles: [{ branchId: "b-1", branch: { id: "b-1" } }] } as never);
    const hook = renderHook(() => useBranchRollout());
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(hook.result.current.rollout).toBeNull();
  });

  it("forgets an earlier answer when a forced refresh fails, and recovers on the next read", async () => {
    const context = (state: PosRollout["state"]) =>
      ({
        branchRoles: [{ branchId: "b-1", branch: { posRollout: { state, liveSince: null, fallback: null } } }],
      }) as never;
    request.mockResolvedValueOnce(context("not_live"));
    const hook = renderHook(() => useBranchRollout());
    await waitFor(() => expect(hook.result.current.rollout?.state).toBe("not_live"));
    expect(hook.result.current).toMatchObject({ resolved: true, failed: false, loading: false });

    request.mockRejectedValueOnce(new Error("offline"));
    await act(async () => notifyPosRolloutChanged());
    await waitFor(() => expect(hook.result.current.failed).toBe(true));
    expect(hook.result.current).toMatchObject({ rollout: null, resolved: false, loading: false });

    // A second component mounting now must not be handed the stale answer either.
    const late = renderHook(() => useBranchRollout());
    expect(late.result.current.rollout).toBeNull();

    request.mockResolvedValue(context("live"));
    await act(async () => notifyPosRolloutChanged());
    await waitFor(() => expect(hook.result.current.rollout?.state).toBe("live"));
    expect(hook.result.current).toMatchObject({ resolved: true, failed: false });
    expect(late.result.current.rollout?.state).toBe("live");
  });

  it("reports a failed first read rather than loading forever", async () => {
    request.mockRejectedValue(new Error("offline"));
    const hook = renderHook(() => useBranchRollout());
    await waitFor(() => expect(hook.result.current.failed).toBe(true));
    expect(hook.result.current).toMatchObject({ rollout: null, loading: false, resolved: false });
  });

  it("ends a fallback on time in an open tab", async () => {
    jest.useFakeTimers({ now: NOW });
    request.mockResolvedValue({
      branchRoles: [{ branchId: "b-1", branch: { posRollout: fallbackUntil("2026-10-27T10:30:00Z") } }],
    } as never);
    const hook = renderHook(() => useBranchRollout());
    await act(async () => {
      await Promise.resolve();
    });
    expect(hook.result.current.rollout?.state).toBe("fallback");

    await act(async () => {
      jest.advanceTimersByTime(30 * 60_000 + 100);
    });
    expect(hook.result.current.rollout?.state).toBe("live");
  });
});
