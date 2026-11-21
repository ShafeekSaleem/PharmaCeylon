import { rowsForHeight } from "./content-rows";

/** react-grid-layout's own height for `h` rows at rowHeight 12 and margin 14. */
const cell = (h: number) => h * 12 + (h - 1) * 14;

describe("rowsForHeight (UI1 #205)", () => {
  it.each([12, 100, 237, 238, 400, 1013])(
    "gives a %ppx card a cell that holds it with less than one row to spare",
    (px) => {
      const h = rowsForHeight(px);
      expect(cell(h)).toBeGreaterThanOrEqual(px);
      expect(cell(h - 1)).toBeLessThan(px);
    },
  );

  it("fits a card exactly when its height lands on a row", () => {
    expect(rowsForHeight(cell(9))).toBe(9);
  });

  it("never returns less than one row, even before the card has a height", () => {
    expect(rowsForHeight(0)).toBe(1);
    expect(rowsForHeight(Number.NaN)).toBe(1);
  });
});
