export type AccentColor = "teal" | "cyan" | "navy";
export type Density = "comfortable" | "compact";
export type FontSize = "small" | "medium" | "large";

export type AppearancePrefs = {
  accent: AccentColor;
  density: Density;
  fontSize: FontSize;
};

const STORAGE_KEY = "pc_appearance";

export const DEFAULT_APPEARANCE_PREFS: AppearancePrefs = {
  accent: "teal",
  density: "comfortable",
  fontSize: "medium",
};

/** Matches the primary/hover/soft/focus-ring token group in globals.css, keyed by the two
 *  alternate accent tokens (--pc-secondary-cyan / --pc-accent-navy) already defined there but
 *  otherwise unused. */
const ACCENT_TOKENS: Record<AccentColor, { primary: string; primaryHover: string; soft: string; ring: string }> = {
  teal: { primary: "#0d9488", primaryHover: "#0f766e", soft: "rgba(13, 148, 136, 0.12)", ring: "rgba(13, 148, 136, 0.25)" },
  cyan: { primary: "#0891b2", primaryHover: "#0e7490", soft: "rgba(8, 145, 178, 0.12)", ring: "rgba(8, 145, 178, 0.25)" },
  navy: { primary: "#1e40af", primaryHover: "#1e3a8a", soft: "rgba(30, 64, 175, 0.12)", ring: "rgba(30, 64, 175, 0.25)" },
};

const FONT_SIZE_PX: Record<FontSize, number> = {
  small: 15,
  medium: 16,
  large: 17,
};

export function readAppearancePrefs(): AppearancePrefs {
  if (typeof window === "undefined") return DEFAULT_APPEARANCE_PREFS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_APPEARANCE_PREFS;
    const parsed = JSON.parse(raw) as Partial<AppearancePrefs>;
    return { ...DEFAULT_APPEARANCE_PREFS, ...parsed };
  } catch {
    return DEFAULT_APPEARANCE_PREFS;
  }
}

export function writeAppearancePrefs(prefs: AppearancePrefs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
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
  const tokens = ACCENT_TOKENS[prefs.accent];
  root.style.setProperty("--pc-primary", tokens.primary);
  root.style.setProperty("--pc-primary-hover", tokens.primaryHover);
  root.style.setProperty("--pc-primary-soft", tokens.soft);
  root.style.setProperty("--pc-focus-ring", tokens.ring);
  root.style.setProperty("--pc-ring", tokens.primary);
  root.style.fontSize = `${FONT_SIZE_PX[prefs.fontSize]}px`;
  root.dataset.density = prefs.density;
}
