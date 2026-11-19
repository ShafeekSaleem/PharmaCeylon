import { dayBarLabel, quietSince } from "./sales-trend-card";

const pts = (values: number[]) =>
  values.map((value, i) => ({
    date: `2026-11-${String(11 + i).padStart(2, "0")}`,
    label: "",
    value,
  }));

it("labels a week by weekday and day, and the last bar as today", () => {
  const p = pts([1, 2]);
  expect(dayBarLabel(p[0], false, 7)).toBe("Wed 11");
  expect(dayBarLabel(p[1], true, 7)).toBe("Today");
  expect(dayBarLabel(p[0], false, 30)).toBe("11 Nov");
});

it("says since when a run of empty days has lasted", () => {
  expect(quietSince(pts([168, 95, 152, 0, 0, 0, 0]), 7)).toBe(
    "No sales recorded since Friday 13 Nov. Check that the counters are sending their sales.",
  );
  expect(quietSince(pts([5, 0]), 7)).toBeNull();
  expect(quietSince(pts([0, 0, 0]), 7)).toBe(
    "No sales recorded in the last 7 days.",
  );
});
