import {
  DEFAULT_PHARMACY_APPEARANCE,
  pharmacyBrandCss,
  type PharmacyAppearance,
  type PharmacyAppearanceSettings,
} from "@pharmaceylon/shared";
import { apiJson } from "./auth-client";

/**
 * The pharmacy brand on the web (Epic UI1 #205, decision 4). The owner's accent becomes a
 * stylesheet with the same selectors as tokens.css, so it follows light/dark without script; the
 * status colour set and the sidebar style are attributes on <html> that CSS reads.
 *
 * The last brand seen is cached in this browser so the pre-paint script can draw it before React
 * loads; the server copy then replaces it.
 */

const CACHE_KEY = "pc_brand";
const STYLE_ID = "pc-brand";
export const BRAND_CHANGED_EVENT = "pc:brand-changed";

type Cached = { settings: PharmacyAppearanceSettings; css: string | null };

/** The default accent is already tokens.css's own (hand-tuned) teal; only a custom one needs CSS. */
export function brandCss(settings: PharmacyAppearanceSettings): string | null {
  return settings.accent === DEFAULT_PHARMACY_APPEARANCE.accent
    ? null
    : pharmacyBrandCss(settings.accent);
}

export function applyPharmacyBrand(settings: PharmacyAppearanceSettings): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const css = brandCss(settings);
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (css) {
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      // Last in <head>, so it wins over tokens.css at equal specificity.
      document.head.appendChild(style);
    }
    if (style.textContent !== css) style.textContent = css;
  } else {
    style?.remove();
  }
  if (settings.statusSet === "colour-blind")
    root.dataset.statusSet = "colour-blind";
  else delete root.dataset.statusSet;
  if (settings.sidebarStyle === "light") delete root.dataset.sidebar;
  else root.dataset.sidebar = settings.sidebarStyle;
}

export function readCachedBrand(): PharmacyAppearanceSettings | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as Cached).settings : null;
  } catch {
    return null;
  }
}

function cacheBrand(settings: PharmacyAppearanceSettings): void {
  try {
    const cached: Cached = { settings, css: brandCss(settings) };
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(cached));
  } catch {
    // Storage off: the brand still applies, it just arrives after first paint.
  }
}

export function fetchPharmacyBrand(): Promise<PharmacyAppearance> {
  return apiJson<PharmacyAppearance>("/tenant/appearance");
}

export function savePharmacyBrand(
  expectedVersion: number,
  appearance: PharmacyAppearanceSettings,
): Promise<PharmacyAppearance> {
  return apiJson<PharmacyAppearance>("/tenant/appearance", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedVersion, appearance }),
  });
}

/** Applies, caches and announces a brand the server confirmed. */
export function adoptPharmacyBrand(brand: PharmacyAppearance): void {
  const settings = settingsOf(brand);
  applyPharmacyBrand(settings);
  cacheBrand(settings);
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<PharmacyAppearance>(BRAND_CHANGED_EVENT, {
        detail: brand,
      }),
    );
  }
}

export function settingsOf(
  brand: PharmacyAppearanceSettings,
): PharmacyAppearanceSettings {
  const {
    accent,
    sidebarStyle,
    chartPalette,
    statusSet,
    counterTheme,
    counterThemeLocked,
  } = brand;
  return {
    accent,
    sidebarStyle,
    chartPalette,
    statusSet,
    counterTheme,
    counterThemeLocked,
  };
}

/**
 * Runs before first paint with the theme script: redraws the last brand this browser saw. A
 * string in the document, so it stays tiny and dependency-free and never throws.
 */
export const BRAND_BOOTSTRAP_SCRIPT = `
(function(){
  try {
    var raw = localStorage.getItem("${CACHE_KEY}");
    if (!raw) return;
    var c = JSON.parse(raw), s = c && c.settings, root = document.documentElement;
    if (!s) return;
    if (typeof c.css === "string" && c.css) {
      var el = document.createElement("style");
      el.id = "${STYLE_ID}";
      el.textContent = c.css;
      document.head.appendChild(el);
    }
    if (s.statusSet === "colour-blind") root.dataset.statusSet = "colour-blind";
    if (s.sidebarStyle === "tinted" || s.sidebarStyle === "dark") root.dataset.sidebar = s.sidebarStyle;
  } catch (e) {}
})();
`;
