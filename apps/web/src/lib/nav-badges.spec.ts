import { act, renderHook } from "@testing-library/react";
import { navBadgeCounts, navBadgeText, useNavBadges } from "./nav-badges";

const apiJson = jest.fn();
jest.mock("./auth-client", () => ({
  apiJson: (...args: unknown[]) => apiJson(...args),
}));

beforeEach(() => apiJson.mockReset());

it("maps the queue's areas onto sidebar links and leaves out empty and unlinked ones", () => {
  expect(
    navBadgeCounts({ purchasing: 3, transfers: 0, returns: 2, counter: 5, stocktakes: 1 }),
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
  rerender({ path: "/inventory" });
  await act(async () => {});
  expect(result.current).toEqual({});
});

it("asks nothing where the back office is closed", async () => {
  const { result } = renderHook(() => useNavBadges("b-1", false, "/dashboard"));
  await act(async () => {});
  expect(apiJson).not.toHaveBeenCalled();
  expect(result.current).toEqual({});
});
