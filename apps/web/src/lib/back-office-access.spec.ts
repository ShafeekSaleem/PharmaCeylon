import { mayOpenWebPath } from "./back-office-access";
import type { PosRollout } from "./branch-rollout";

const live: PosRollout = { state: "live", liveSince: null, fallback: null };

describe("web-only access scope", () => {
  it("blocks direct back-office paths for a counter-only role after go-live", () => {
    for (const path of [
      "/dashboard",
      "/products/secret",
      "/sales/123",
      "/settings/branches",
      "/notifications",
      "/pos",
    ]) {
      expect(mayOpenWebPath(path, false, live)).toBe(false);
      expect(mayOpenWebPath(path, true, live)).toBe(true);
    }
  });

  it("retains legacy web workflows before branch go-live", () => {
    expect(mayOpenWebPath("/pos", false, { ...live, state: "not_live" })).toBe(true);
    expect(mayOpenWebPath("/products", false, { ...live, state: "not_live" })).toBe(true);
  });

  it("permits only checkout and personal settings during fallback for a counter-only role", () => {
    const fallback: PosRollout = { ...live, state: "fallback" };
    expect(mayOpenWebPath("/pos", false, fallback)).toBe(true);
    expect(mayOpenWebPath("/sales", false, fallback)).toBe(false);
    for (const path of [
      "/settings/my-profile",
      "/settings/password-login",
      "/settings/appearance",
    ]) {
      expect(mayOpenWebPath(path, false, fallback)).toBe(true);
    }
  });

  it("does not mount back-office content while branch scope is unknown", () => {
    expect(mayOpenWebPath("/products", true, null)).toBe(false);
    expect(mayOpenWebPath("/settings/my-profile", false, null)).toBe(true);
  });
});
