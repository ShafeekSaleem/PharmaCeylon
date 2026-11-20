import { saleTillCell, saleTillLabel } from "./till-display";
import type { SaleListRow } from "./types";

describe("saleTillLabel", () => {
  it("returns the API till name when present", () => {
    expect(
      saleTillLabel({
        register: { id: "r", tillId: "t", label: "Counter 1" },
        till: { id: "t", label: "Till 1" },
      }),
    ).toBe("Till 1");
  });

  it("returns register.tillLabel when till is absent", () => {
    expect(
      saleTillLabel({
        register: { id: "r", tillId: "t", label: "Counter 1", tillLabel: "Drawer A" },
        till: null,
      }),
    ).toBe("Drawer A");
  });

  it("returns null when the API sends no till name", () => {
    expect(
      saleTillLabel({
        register: { id: "r", tillId: "t", label: "Counter 1 Floor 2" } as SaleListRow["register"],
        till: null,
      }),
    ).toBeNull();
  });
});

describe("saleTillCell", () => {
  it("shows an em dash when there is no till name", () => {
    expect(saleTillCell({ register: { id: "r", tillId: "t", label: "Counter 1" }, till: null })).toBe("—");
  });
});