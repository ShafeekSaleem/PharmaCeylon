import { breakdownBars } from "./sales-section";
import type { SalesBreakdownRow } from "../lib/types";

const row = (over: Partial<SalesBreakdownRow>): SalesBreakdownRow => ({
  key: "k",
  label: "label",
  count: 1,
  grandTotal: "100.00",
  ...over,
});

describe("breakdownBars", () => {
  it("names fallback and offline channels and says what they mean", () => {
    const bars = breakdownBars(
      [
        row({ key: "desktop_online", channel: "desktop_online", count: 4, grandTotal: "900.00" }),
        row({ key: "fallback", channel: "fallback", count: 2, grandTotal: "250.00" }),
        row({ key: "offline", channel: "offline", count: 1, grandTotal: "300.00" }),
      ],
      "channel",
    );
    expect(bars.map((b) => b.label)).toEqual(["Counter (online)", "Counter (offline)", "Web fallback"]);
    expect(bars[1]!.sublabel).toBe("1 sale · Sold while the counter was offline, dated when it happened");
    expect(bars[2]!.sublabel).toMatch(/^2 sales · Sold on the web while the branch's counters were down$/);
  });

  it("shows a counter by its name, with the computer beside it, and web sales as having no counter", () => {
    const bars = breakdownBars(
      [
        row({ key: "t1", label: "FRONT-PC", terminal: { id: "t1", label: "FRONT-PC" }, register: { id: "r1", tillId: "till1", label: "Counter 1" } }),
        row({ key: "none", label: "No counter", terminal: null, grandTotal: "50.00" }),
      ],
      "terminal",
    );
    expect(bars[0]).toMatchObject({ label: "Counter 1", sublabel: "1 sale · FRONT-PC", value: 100 });
    expect(bars[1]).toMatchObject({ label: "Web (no counter)", value: 50 });
  });

  it("labels a shift by counter and number and flags one still open", () => {
    const [bar] = breakdownBars(
      [
        row({
          key: "s1",
          shift: { id: "s1", shiftNumber: "S-0007", registerId: "r1", registerLabel: "Counter 1", openedAt: "2026-11-26T03:00:00.000Z", closedAt: null },
        }),
      ],
      "shift",
    );
    expect(bar!.label).toBe("Counter 1 · S-0007");
    expect(bar!.sublabel).toMatch(/still open$/);
  });
});
