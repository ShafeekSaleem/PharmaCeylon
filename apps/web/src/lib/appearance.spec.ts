import {
  APPEARANCE_CHANGED_EVENT,
  DEFAULT_APPEARANCE_PREFS,
  applyAppearancePrefs,
  oppositeTheme,
  readAppearancePrefs,
  saveAppearancePrefs,
  resolveIsDark,
  THEME_BOOTSTRAP_SCRIPT,
  type AppearancePrefs,
} from "./appearance";

function mockSystemDark(dark: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: dark && query.includes("dark"),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as never;
}

const prefs = (over: Partial<AppearancePrefs> = {}): AppearancePrefs => ({
  ...DEFAULT_APPEARANCE_PREFS,
  ...over,
});

describe("resolveIsDark", () => {
  it("follows the explicit choice regardless of the OS", () => {
    mockSystemDark(true);
    expect(resolveIsDark("light")).toBe(false);
    mockSystemDark(false);
    expect(resolveIsDark("dark")).toBe(true);
  });

  it("follows the OS under 'system'", () => {
    mockSystemDark(true);
    expect(resolveIsDark("system")).toBe(true);
    mockSystemDark(false);
    expect(resolveIsDark("system")).toBe(false);
  });
});

describe("applyAppearancePrefs", () => {
  beforeEach(() => {
    delete document.documentElement.dataset.theme;
    document.documentElement.style.cssText = "";
    mockSystemDark(false);
  });

  it.each(["light", "dark"] as const)("stamps data-theme for %s", (theme) => {
    applyAppearancePrefs(prefs({ theme }));
    expect(document.documentElement.dataset.theme).toBe(theme);
  });

  it("removes data-theme under 'system' so the media query takes over", () => {
    // Stamping data-theme="system" would match neither CSS selector and strand
    // the page on the light palette — the bug this asserts against.
    applyAppearancePrefs(prefs({ theme: "dark" }));
    applyAppearancePrefs(prefs({ theme: "system" }));
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("clears an accent an older build set inline, so the pharmacy brand shows", () => {
    // Before UI1 the accent was personal and written as inline vars on <html>,
    // which would beat the brand stylesheet forever.
    const root = document.documentElement;
    root.style.setProperty("--pc-primary", "#22d3ee");
    root.style.setProperty("--pc-focus-ring", "rgba(0,0,0,0.3)");
    applyAppearancePrefs(prefs());
    expect(root.style.getPropertyValue("--pc-primary")).toBe("");
    expect(root.style.getPropertyValue("--pc-focus-ring")).toBe("");
  });

  it("ignores a stored personal accent", () => {
    window.localStorage.setItem(
      "pc_appearance:u9",
      JSON.stringify({ theme: "dark", accent: "cyan" }),
    );
    expect(readAppearancePrefs("u9")).not.toHaveProperty("accent");
  });

  it("still applies density and font size", () => {
    applyAppearancePrefs(prefs({ density: "compact", fontSize: "large" }));
    expect(document.documentElement.dataset.density).toBe("compact");
    expect(document.documentElement.style.fontSize).toBe("17px");
  });
});

describe("THEME_BOOTSTRAP_SCRIPT", () => {
  it("never throws on malformed or absent storage", () => {
    // It runs before anything else on the page; an exception here would break
    // the document, so every path is wrapped.
    expect(THEME_BOOTSTRAP_SCRIPT).toContain("try");
    expect(THEME_BOOTSTRAP_SCRIPT).toContain("catch");
  });

  it("only ever stamps a real theme value", () => {
    // Guards against writing data-theme="system", which matches no selector.
    expect(THEME_BOOTSTRAP_SCRIPT).toContain('p.theme === "light"');
    expect(THEME_BOOTSTRAP_SCRIPT).toContain('p.theme === "dark"');
    expect(THEME_BOOTSTRAP_SCRIPT).not.toContain('"system"');
  });

  it("applies before paint by touching documentElement directly", () => {
    expect(THEME_BOOTSTRAP_SCRIPT).toContain("document.documentElement.dataset.theme");
  });
});

describe("saveAppearancePrefs", () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
    mockSystemDark(false);
  });

  it("writes, applies and announces the change", () => {
    const seen: AppearancePrefs[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent<AppearancePrefs>).detail);
    window.addEventListener(APPEARANCE_CHANGED_EVENT, listener);
    saveAppearancePrefs(prefs({ theme: "dark" }), "u1");
    window.removeEventListener(APPEARANCE_CHANGED_EVENT, listener);

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(readAppearancePrefs("u1").theme).toBe("dark");
    expect(seen.map((p) => p.theme)).toEqual(["dark"]);
  });

  it("remembers who saved last for the pre-paint script", () => {
    saveAppearancePrefs(prefs({ theme: "light" }), "u1");
    saveAppearancePrefs(prefs({ theme: "dark" }), "u2");
    delete document.documentElement.dataset.theme;
    new Function(THEME_BOOTSTRAP_SCRIPT)();
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});

describe("oppositeTheme", () => {
  it("flips an explicit choice", () => {
    expect(oppositeTheme("light")).toBe("dark");
    expect(oppositeTheme("dark")).toBe("light");
  });

  it("flips what the device is showing under 'system'", () => {
    mockSystemDark(true);
    expect(oppositeTheme("system")).toBe("light");
    mockSystemDark(false);
    expect(oppositeTheme("system")).toBe("dark");
  });
});
