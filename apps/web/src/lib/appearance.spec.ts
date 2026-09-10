import {
  DEFAULT_APPEARANCE_PREFS,
  applyAppearancePrefs,
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

  it("uses the lifted accent on a dark ground", () => {
    applyAppearancePrefs(prefs({ theme: "dark", accent: "teal" }));
    // The light teal (#0d9488) is too dark on #0b1220 to read as an action.
    expect(
      document.documentElement.style.getPropertyValue("--pc-primary"),
    ).toBe("#2dd4bf");
  });

  it("uses the light accent on a light ground", () => {
    applyAppearancePrefs(prefs({ theme: "light", accent: "teal" }));
    expect(
      document.documentElement.style.getPropertyValue("--pc-primary"),
    ).toBe("#0d9488");
  });

  it("resolves the accent through the OS under 'system'", () => {
    mockSystemDark(true);
    applyAppearancePrefs(prefs({ theme: "system", accent: "cyan" }));
    expect(
      document.documentElement.style.getPropertyValue("--pc-primary"),
    ).toBe("#22d3ee");
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
