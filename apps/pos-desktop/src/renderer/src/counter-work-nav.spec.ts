import { describe, expect, it } from "@jest/globals";
import { showCounterWorkNav } from "./counter-work-nav";

describe("showCounterWorkNav", () => {
  it.each(["owner", "manager", "pharmacist", "cashier", "inventory_clerk"])(
    "shows Counter work for built-in role %s",
    (role) => {
      expect(showCounterWorkNav(role)).toBe(true);
    },
  );

  it("hides Counter work for custom roles and missing role", () => {
    expect(showCounterWorkNav("custom")).toBe(false);
    expect(showCounterWorkNav(null)).toBe(false);
    expect(showCounterWorkNav(undefined)).toBe(false);
  });
});
