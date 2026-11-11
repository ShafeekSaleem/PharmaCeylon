/** @jest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { renderHook } from "@testing-library/react";
import { READINESS_POLL_MS, useShellReadinessPoll } from "./shell-readiness";

describe("useShellReadinessPoll", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("polls readiness on an interval while the shell is active", () => {
    const refresh = jest.fn();
    renderHook(() => useShellReadinessPoll(true, refresh, true));
    expect(refresh).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(READINESS_POLL_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(READINESS_POLL_MS);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("re-reads readiness when server reachability changes", () => {
    const refresh = jest.fn();
    const { rerender } = renderHook(
      ({ reachable }: { reachable: boolean }) =>
        useShellReadinessPoll(true, refresh, reachable),
      { initialProps: { reachable: true } },
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    rerender({ reachable: false });
    expect(refresh).toHaveBeenCalledTimes(2);
    rerender({ reachable: false });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("clears the poll timer on unmount", () => {
    const refresh = jest.fn();
    const { unmount } = renderHook(() => useShellReadinessPoll(true, refresh, true));
    expect(refresh).toHaveBeenCalledTimes(1);
    unmount();
    jest.advanceTimersByTime(READINESS_POLL_MS * 3);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
