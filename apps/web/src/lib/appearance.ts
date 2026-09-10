/** "system" follows the OS; the other two stamp `data-theme` and win over it. */
export type Theme = "system" | "light" | "dark";

export type AccentColor = "teal" | "cyan" | "navy";
export type Density = "comfortable" | "compact";
export type FontSize = "small" | "medium" | "large";

export type AppearancePrefs = {
  theme: Theme;
  accent: AccentColor;
  density: Density;
  fontSize: FontSize;
};

const STORAGE_KEY = "pc_appearance";

function storageKey(userId?: string): string {
  return userId ? `${STORAGE_KEY}:${userId}` : STORAGE_KEY;
}

export const DEFAULT_APPEARANCE_PREFS: AppearancePrefs = {
  // Defaulting to the OS setting means a viewer who already runs their machine
  // dark never sees a bright flash of a product they didn't configure.
  theme: "system",
  accent: "teal",
  density: "comfortable",
  fontSize: "medium",
};

/** Matches the primary/hover/soft/focus-ring token group in globals.css, keyed by the two
 *  alternate accent tokens (--pc-secondary-cyan / --pc-accent-navy) already defined there but
 *  otherwise unused. */
/* These MUST stay literal hex. They are the values written into
   `--pc-primary` and friends, so a var() reference here would define a token in
   terms of itself and resolve to nothing. */
const ACCENT_TOKENS: Record<AccentColor, { primary: string; primaryHover: string; soft: string; ring: string }> = {
  teal: { primary: "#0d9488", primaryHover: "#0f766e", soft: "rgba(13, 148, 136, 0.12)", ring: "rgba(13, 148, 136, 0.25)" },
  cyan: { primary: "#0891b2", primaryHover: "#0e7490", soft: "rgba(8, 145, 178, 0.12)", ring: "rgba(8, 145, 178, 0.25)" },
  navy: { primary: "#1e40af", primaryHover: "#1e3a8a", soft: "rgba(30, 64, 175, 0.12)", ring: "rgba(30, 64, 175, 0.25)" },
};

/** The same three accents lifted for a dark ground. Re-skinning with the light
 *  values would undo the contrast the dark palette in globals.css sets up. */
const ACCENT_TOKENS_DARK: Record<AccentColor, { primary: string; primaryHover: string; soft: string; ring: string }> = {
  teal: { primary: "#2dd4bf", primaryHover: "#5eead4", soft: "rgba(45, 212, 191, 0.16)", ring: "rgba(45, 212, 191, 0.35)" },
  cyan: { primary: "#22d3ee", primaryHover: "#67e8f9", soft: "rgba(34, 211, 238, 0.16)", ring: "rgba(34, 211, 238, 0.35)" },
  navy: { primary: "#60a5fa", primaryHover: "#93c5fd", soft: "rgba(96, 165, 250, 0.16)", ring: "rgba(96, 165, 250, 0.35)" },
};

/** Which palette is actually showing, accounting for "system". */
export function resolveIsDark(theme: Theme): boolean {
  if (theme === "dark") return true;
  if (theme === "light") return false;
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

const FONT_SIZE_PX: Record<FontSize, number> = {
  small: 15,
  medium: 16,
  large: 17,
};

export function readAppearancePrefs(userId?: string): AppearancePrefs {
  if (typeof window === "undefined") return DEFAULT_APPEARANCE_PREFS;
  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    if (!raw) return DEFAULT_APPEARANCE_PREFS;
    const parsed = JSON.parse(raw) as Partial<AppearancePrefs>;
    return { ...DEFAULT_APPEARANCE_PREFS, ...parsed };
  } catch {
    return DEFAULT_APPEARANCE_PREFS;
  }
}

export function writeAppearancePrefs(prefs: AppearancePrefs, userId?: string): void {
  try {
    window.localStorage.setItem(storageKey(userId), JSON.stringify(prefs));
  } catch {
    // Private browsing / storage disabled — preference just won't survive a reload.
  }
}

/** Applies preferences to the live DOM: accent re-skins --pc-primary and friends everywhere
 *  they're already consumed via var(); font size scales the rem-based root so most of the
 *  app's spacing/type scales with it; density sets a data attribute that a couple of the most
 *  broadly-used shared components (FormField's .control, ActionButton) read via :global(). */
export function applyAppearancePrefs(prefs: AppearancePrefs): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;

  // "system" removes the attribute entirely so the prefers-color-scheme block
  // in globals.css takes over. Stamping data-theme="system" would match neither
  // selector and leave the page on the light palette.
  if (prefs.theme === "system") {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = prefs.theme;
  }

  const tokens = (resolveIsDark(prefs.theme) ? ACCENT_TOKENS_DARK : ACCENT_TOKENS)[
    prefs.accent
  ];
  root.style.setProperty("--pc-primary", tokens.primary);
  root.style.setProperty("--pc-primary-hover", tokens.primaryHover);
  root.style.setProperty("--pc-primary-soft", tokens.soft);
  root.style.setProperty("--pc-focus-ring", tokens.ring);
  root.style.setProperty("--pc-ring", tokens.primary);
  root.style.fontSize = `${FONT_SIZE_PX[prefs.fontSize]}px`;
  root.dataset.density = prefs.density;
}

/**
 * Re-applies the accent when the OS flips while "System" is selected.
 *
 * Without this the accent inline styles keep whichever palette was resolved at
 * mount, so a viewer whose machine switches to dark at sunset gets the dark
 * background with the light-mode teal on top of it. Returns an unsubscribe.
 */
export function watchSystemTheme(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/**
 * Runs before first paint, inlined into <head>, to avoid a flash of the wrong
 * theme: React only applies preferences after hydration, which is several
 * hundred milliseconds of white for a dark-mode viewer.
 *
 * Kept deliberately tiny and dependency-free — it is a string in the document,
 * not a module. It reads the same storage keys as readAppearancePrefs; the
 * per-user key is tried first, then the anonymous one, since the signed-in
 * user id is not known this early on a cold load.
 */
export const THEME_BOOTSTRAP_SCRIPT = `
(function(){
  try {
    var raw = null;
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k === "${STORAGE_KEY}" || (k && k.indexOf("${STORAGE_KEY}:") === 0)) {
        raw = localStorage.getItem(k);
        if (k !== "${STORAGE_KEY}") break;
      }
    }
    if (!raw) return;
    var p = JSON.parse(raw);
    if (p.theme === "light" || p.theme === "dark") {
      document.documentElement.dataset.theme = p.theme;
    }
    if (p.density) document.documentElement.dataset.density = p.density;
  } catch (e) {}
})();
`;
