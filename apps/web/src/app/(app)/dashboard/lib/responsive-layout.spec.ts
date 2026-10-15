import { packDashboardLayout } from "./responsive-layout";

it("packs tablet cards together after a full-width chart", () => {
  const layout = packDashboardLayout(
    [
      { i: "chart", x: 0, y: 0, w: 8, h: 15 },
      { i: "payments", x: 8, y: 0, w: 4, h: 11 },
      { i: "recent", x: 8, y: 11, w: 4, h: 7 },
    ],
    8,
  );
  expect(layout).toEqual([
    { i: "chart", x: 0, y: 0, w: 8, h: 15 },
    { i: "payments", x: 0, y: 15, w: 4, h: 11 },
    { i: "recent", x: 4, y: 15, w: 4, h: 7 },
  ]);
  const mobile = packDashboardLayout(layout, 1);
  expect(mobile.map((item) => item.x)).toEqual([0, 0, 0]);
  expect(mobile.map((item) => item.w)).toEqual([1, 1, 1]);
  expect(mobile.map((item) => item.y)).toEqual([0, 15, 26]);
});
