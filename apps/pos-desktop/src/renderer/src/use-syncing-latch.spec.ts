/** @jest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { renderHook, act } from "@testing-library/react";
import { SYNCING_LATCH_MS, useSyncingLatch } from "./use-syncing-latch";

describe("useSyncingLatch", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("shows syncing only after 1 s and holds for 1 s after it ends", () => {
    const { result, rerender } = renderHook(
      ({ syncing }) => useSyncingLatch(syncing),
      { initialProps: { syncing: true } },
    );
    expect(result.current).toBe(false);
    act(() => {
      jest.advanceTimersByTime(SYNCING_LATCH_MS);
    });
    expect(result.current).toBe(true);

    rerender({ syncing: false });
    expect(result.current).toBe(true);
    act(() => {
      jest.advanceTimersByTime(SYNCING_LATCH_MS - 1);
    });
    expect(result.current).toBe(true);
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(result.current).toBe(false);
  });

  it("does not latch when syncing ends before 1 s", () => {
    const { result, rerender } = renderHook(
      ({ syncing }) => useSyncingLatch(syncing),
      { initialProps: { syncing: true } },
    );
    act(() => {
      jest.advanceTimersByTime(500);
    });
    rerender({ syncing: false });
    act(() => {
      jest.advanceTimersByTime(SYNCING_LATCH_MS);
    });
    expect(result.current).toBe(false);
  });
});
