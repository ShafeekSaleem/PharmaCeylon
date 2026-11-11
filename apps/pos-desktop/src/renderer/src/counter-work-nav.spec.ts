import { describe, expect, it } from "@jest/globals";
import {
  shouldRedirectFromWorkPage,
  showCounterWorkNav,
  showCounterWorkRail,
} from "./counter-work-nav";

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

describe("showCounterWorkRail (PR #170)", () => {
  it("shows Counter work for a custom role when work is waiting", () => {
    expect(showCounterWorkRail("custom", 3, "sell")).toBe(true);
  });

  it("hides Counter work for a custom role with nothing waiting", () => {
    expect(showCounterWorkRail("custom", 0, "sell")).toBe(false);
  });

  it("keeps Counter work on screen while the work page is open", () => {
    expect(showCounterWorkRail("custom", 0, "work")).toBe(true);
  });
});

describe("shouldRedirectFromWorkPage (PR #170)", () => {
  it("does not redirect while work is waiting", () => {
    expect(shouldRedirectFromWorkPage("custom", 2)).toBe(false);
  });

  it("redirects when the role lacks grant and no work is waiting", () => {
    expect(shouldRedirectFromWorkPage("custom", 0)).toBe(true);
    expect(shouldRedirectFromWorkPage(null, 0)).toBe(true);
  });

  it("does not redirect built-in roles even with an empty queue", () => {
    expect(shouldRedirectFromWorkPage("cashier", 0)).toBe(false);
  });
});
