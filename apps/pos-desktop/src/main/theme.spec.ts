import { describe, expect, it } from "@jest/globals";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCounterTheme,
  readCounterTheme,
  type CounterThemePolicy,
  type ThemeTarget,
} from "./theme";

const fresh = () =>
  join(
    mkdtempSync(join(tmpdir(), "pos-theme-")),
    "nested",
    "counter-theme.json",
  );

describe("counter theme", () => {
  it("follows Windows when nothing is saved and the pharmacy set no default", () => {
    const target: ThemeTarget = { themeSource: "dark" };
    expect(createCounterTheme(fresh(), target).apply()).toEqual({
      theme: "system",
      locked: false,
    });
    expect(target.themeSource).toBe("system");
  });

  it("applies and remembers a choice on this computer", () => {
    const path = fresh();
    const target: ThemeTarget = { themeSource: "system" };
    createCounterTheme(path, target).set("light");
    expect(target.themeSource).toBe("light");

    // A later start of the app picks it up before the window exists.
    const restarted: ThemeTarget = { themeSource: "system" };
    expect(createCounterTheme(path, restarted).apply().theme).toBe("light");
    expect(restarted.themeSource).toBe("light");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ theme: "light" });
  });

  it("ignores a broken or foreign file", () => {
    const path = fresh();
    createCounterTheme(path, { themeSource: "system" }).set("dark");
    writeFileSync(path, "{not json");
    expect(readCounterTheme(path)).toBeNull();
    writeFileSync(path, JSON.stringify({ theme: "sepia" }));
    expect(readCounterTheme(path)).toBeNull();
  });

  it("starts from the pharmacy's default until the cashier chooses", () => {
    const path = fresh();
    const target: ThemeTarget = { themeSource: "system" };
    const theme = createCounterTheme(path, target, () => ({
      theme: "dark",
      locked: false,
    }));
    expect(theme.apply()).toEqual({ theme: "dark", locked: false });
    expect(theme.set("light")).toEqual({ theme: "light", locked: false });
    expect(target.themeSource).toBe("light");
  });

  it("holds the pharmacy's theme while locked, and gives the cashier's back when unlocked", () => {
    const path = fresh();
    const target: ThemeTarget = { themeSource: "system" };
    let policy: CounterThemePolicy = { theme: "system", locked: false };
    const theme = createCounterTheme(path, target, () => policy);
    theme.set("dark");

    policy = { theme: "light", locked: true };
    expect(theme.apply()).toEqual({ theme: "light", locked: true });
    expect(target.themeSource).toBe("light");
    // The switch is hidden, and main refuses it too.
    expect(theme.set("dark")).toEqual({ theme: "light", locked: true });
    expect(target.themeSource).toBe("light");

    policy = { theme: "light", locked: false };
    expect(theme.apply()).toEqual({ theme: "dark", locked: false });
  });
});
