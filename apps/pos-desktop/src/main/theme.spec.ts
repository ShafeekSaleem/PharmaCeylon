import { describe, expect, it } from "@jest/globals";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCounterTheme,
  readCounterTheme,
  type ThemeTarget,
} from "./theme";

const fresh = () =>
  join(
    mkdtempSync(join(tmpdir(), "pos-theme-")),
    "nested",
    "counter-theme.json",
  );

describe("counter theme", () => {
  it("follows Windows when nothing is saved", () => {
    const target: ThemeTarget = { themeSource: "dark" };
    expect(createCounterTheme(fresh(), target).apply()).toBe("system");
    expect(target.themeSource).toBe("system");
  });

  it("applies and remembers a choice on this computer", () => {
    const path = fresh();
    const target: ThemeTarget = { themeSource: "system" };
    createCounterTheme(path, target).set("light");
    expect(target.themeSource).toBe("light");

    // A later start of the app picks it up before the window exists.
    const restarted: ThemeTarget = { themeSource: "system" };
    expect(createCounterTheme(path, restarted).apply()).toBe("light");
    expect(restarted.themeSource).toBe("light");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ theme: "light" });
  });

  it("ignores a broken or foreign file", () => {
    const path = fresh();
    createCounterTheme(path, { themeSource: "system" }).set("dark");
    writeFileSync(path, "{not json");
    expect(readCounterTheme(path)).toBe("system");
    writeFileSync(path, JSON.stringify({ theme: "sepia" }));
    expect(readCounterTheme(path)).toBe("system");
  });
});
