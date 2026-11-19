import { act, renderHook } from "@testing-library/react";
import {
  NAV_BADGE_MIN_GAP_MS,
  navBadgeCounts,
  navBadgeText,
  useNavBadges,
} from "./nav-badges";

const apiJson = jest.fn();
jest.mock("./auth-client", () => ({
  apiJson: (...args: unknown[]) => apiJson(...args),
}));

let now = 1_000_000;
beforeEach(() => {
  apiJson.mockReset();
  now = 1_000_000;
  jest.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => jest.restoreAllMocks());

it("maps the queue's areas onto sidebar links and leaves out empty and unlinked ones", () => {
  expect(
    navBadgeCounts({
      purchasing: 3,
      transfers: 0,
      returns: 2,
      counter: 5,
      stocktakes: 1,
    }),
  ).toEqual({ "/purchasing": 3, "/stocktakes": 1 });
  expect(navBadgeCounts(undefined)).toEqual({});
});

it("keeps the badge one small pill", () => {
  expect(navBadgeText(7)).toBe("7");
  expect(navBadgeText(99)).toBe("99");
  expect(navBadgeText(140)).toBe("99+");
});

it("reads the counts for the selected branch and again on navigation", async () => {
  apiJson.mockResolvedValue({ categories: { inventory: 4 } });
  const { result, rerender } = renderHook(
    ({ path }) => useNavBadges("b-1", true, path),
    { initialProps: { path: "/dashboard" } },
  );
  await act(async () => {});
  expect(result.current).toEqual({ "/inventory": 4 });
  expect(apiJson).toHaveBeenCalledWith(
    expect.stringContaining("/dashboard/work?"),
    expect.objectContaining({ headers: { "x-branch-id": "b-1" } }),
  );
  apiJson.mockResolvedValue({ categories: {} });
  now += NAV_BADGE_MIN_GAP_MS;
  rerender({ path: "/inventory" });
  await act(async () => {});
  expect(apiJson).toHaveBeenCalledTimes(2);
  expect(result.current).toEqual({});
});

it("reuses a read from a moment ago instead of running the queue again", async () => {
  apiJson.mockResolvedValue({ categories: { inventory: 4 } });
  const { result, rerender } = renderHook(
    ({ path }) => useNavBadges("b-1", true, path),
    { initialProps: { path: "/dashboard" } },
  );
  await act(async () => {});
  now += NAV_BADGE_MIN_GAP_MS - 1;
  rerender({ path: "/inventory" });
  // A tab switch fires both of these; together they make at most one request.
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(apiJson).toHaveBeenCalledTimes(1);
  expect(result.current).toEqual({ "/inventory": 4 });
});

it("never shows one branch's counts at another, even when the new read fails", async () => {
  apiJson.mockResolvedValueOnce({ categories: { purchasing: 3 } });
  const { result, rerender } = renderHook(
    ({ branch }) => useNavBadges(branch, true, "/dashboard"),
    { initialProps: { branch: "b-1" } },
  );
  await act(async () => {});
  expect(result.current).toEqual({ "/purchasing": 3 });
  apiJson.mockRejectedValueOnce(new Error("offline"));
  rerender({ branch: "b-2" });
  expect(result.current).toEqual({});
  await act(async () => {});
  expect(result.current).toEqual({});
});

it("keeps the counts it has when a refresh for the same branch fails", async () => {
  apiJson.mockResolvedValueOnce({ categories: { transfers: 8 } });
  const { result, rerender } = renderHook(
    ({ path }) => useNavBadges("b-1", true, path),
    { initialProps: { path: "/dashboard" } },
  );
  await act(async () => {});
  apiJson.mockRejectedValueOnce(new Error("offline"));
  now += NAV_BADGE_MIN_GAP_MS;
  rerender({ path: "/transfers" });
  await act(async () => {});
  expect(apiJson).toHaveBeenCalledTimes(2);
  expect(result.current).toEqual({ "/transfers": 8 });
});

it("asks nothing where the back office is closed", async () => {
  const { result } = renderHook(() => useNavBadges("b-1", false, "/dashboard"));
  await act(async () => {});
  expect(apiJson).not.toHaveBeenCalled();
  expect(result.current).toEqual({});
});
