/** "system" follows the OS; the other two stamp `data-theme` and win over it. */
export type Theme = "system" | "light" | "dark";

export type Density = "comfortable" | "compact";
export type FontSize = "small" | "medium" | "large";

export type AppearancePrefs = {
  theme: Theme;
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
  density: "comfortable",
  fontSize: "medium",
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
    // Older saves carry a personal "accent"; it is ignored (the accent is the pharmacy's now).
    const { theme, density, fontSize } = JSON.parse(raw) as Partial<AppearancePrefs>;
    return {
      ...DEFAULT_APPEARANCE_PREFS,
      ...(theme ? { theme } : {}),
      ...(density ? { density } : {}),
      ...(fontSize ? { fontSize } : {}),
    };
  } catch {
    return DEFAULT_APPEARANCE_PREFS;
  }
}

/** Remembers whose preferences were saved last, so the pre-paint script picks that person's theme
 *  on a shared browser rather than whichever per-user key storage happens to list first. */
const LAST_USER_KEY = `${STORAGE_KEY}_last_user`;

export function writeAppearancePrefs(prefs: AppearancePrefs, userId?: string): void {
  try {
    window.localStorage.setItem(storageKey(userId), JSON.stringify(prefs));
    if (userId) window.localStorage.setItem(LAST_USER_KEY, userId);
  } catch {
    // Private browsing / storage disabled — preference just won't survive a reload.
  }
}

/** Fired on window after preferences are saved, so the top-bar switch and the Appearance page stay
 *  in step when either one changes the theme. */
export const APPEARANCE_CHANGED_EVENT = "pc:appearance-changed";

/** Saves, applies and announces preferences in one step. Every control that changes appearance
 *  goes through here. */
export function saveAppearancePrefs(prefs: AppearancePrefs, userId?: string): void {
  writeAppearancePrefs(prefs, userId);
  applyAppearancePrefs(prefs);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<AppearancePrefs>(APPEARANCE_CHANGED_EVENT, { detail: prefs }));
  }
}

/** The top-bar switch flips whatever is showing now. Under "system" that means leaving "system":
 *  the person asked for the other look, so it becomes their explicit choice. The Appearance page
 *  still offers "Match device" to go back. */
export function oppositeTheme(theme: Theme): Exclude<Theme, "system"> {
  return resolveIsDark(theme) ? "light" : "dark";
}

/** Applies preferences to the live DOM. The accent is not a personal preference any more: it is
 *  the pharmacy brand (UI1 #205, lib/pharmacy-brand.ts). Font size scales the rem-based root so
 *  most of the app's spacing/type scales with it; density sets a data attribute that a couple of the most
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

  // Before UI1 #205 each person picked an accent, written inline here; clear any left on the page.
  for (const name of ["--pc-primary", "--pc-primary-hover", "--pc-primary-soft", "--pc-focus-ring", "--pc-ring"])
    root.style.removeProperty(name);
  root.style.fontSize = `${FONT_SIZE_PX[prefs.fontSize]}px`;
  root.dataset.density = prefs.density;
}

/**
 * Calls back when the OS flips light/dark (the top-bar switch uses it to keep its icon right).
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
 * not a module. It reads the same storage keys as readAppearancePrefs. The
 * signed-in user id is not known this early on a cold load, so it tries the
 * person who saved last, then any per-user key, then the anonymous one.
 */
export const THEME_BOOTSTRAP_SCRIPT = `
(function(){
  try {
    var raw = null;
    var last = localStorage.getItem("${LAST_USER_KEY}");
    if (last) raw = localStorage.getItem("${STORAGE_KEY}:" + last);
    for (var i = 0; !raw && i < localStorage.length; i++) {
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
