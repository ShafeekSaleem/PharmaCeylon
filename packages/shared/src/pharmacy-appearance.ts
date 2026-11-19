/**
 * Pharmacy brand (Epic UI1 #205, decision 4): one appearance for everyone at the pharmacy, set by
 * the owner, stored on the server and applied on the web, the desktop counter app and the receipt
 * header. Each person still keeps their own light/dark, density and text size.
 *
 * The contrast rule lives here so the API refuses exactly what the web form refuses.
 */

export type SidebarStyle = "light" | "tinted" | "dark";
export type ChartPalette = "accent" | "distinct";
export type StatusColourSet = "standard" | "colour-blind";
export type CounterThemeDefault = "system" | "light" | "dark";

export const SIDEBAR_STYLES: readonly SidebarStyle[] = [
  "light",
  "tinted",
  "dark",
];
export const CHART_PALETTES: readonly ChartPalette[] = ["accent", "distinct"];
export const STATUS_COLOUR_SETS: readonly StatusColourSet[] = [
  "standard",
  "colour-blind",
];
export const COUNTER_THEME_DEFAULTS: readonly CounterThemeDefault[] = [
  "system",
  "light",
  "dark",
];

/** What the owner chooses. */
export interface PharmacyAppearanceSettings {
  /** 6-digit lower-case hex, e.g. "#0f766e". */
  accent: string;
  sidebarStyle: SidebarStyle;
  chartPalette: ChartPalette;
  statusSet: StatusColourSet;
  /** The counter app's starting theme; cashiers can switch unless locked. */
  counterTheme: CounterThemeDefault;
  counterThemeLocked: boolean;
}

/** As the API returns it. `version` is 0 until the owner first saves. */
export interface PharmacyAppearance extends PharmacyAppearanceSettings {
  version: number;
  updatedAt: string | null;
}

export const DEFAULT_PHARMACY_APPEARANCE: PharmacyAppearanceSettings = {
  accent: "#0f766e",
  sidebarStyle: "light",
  chartPalette: "accent",
  statusSet: "standard",
  counterTheme: "system",
  counterThemeLocked: false,
};

/** The swatches offered on Settings › Appearance. Every one passes {@link accentProblem}. */
export const ACCENT_PRESETS: readonly { name: string; hex: string }[] = [
  { name: "Teal", hex: "#0f766e" },
  { name: "Ocean", hex: "#1d5fa8" },
  { name: "Indigo", hex: "#4338ca" },
  { name: "Plum", hex: "#86198f" },
  { name: "Forest", hex: "#166534" },
  { name: "Clay", hex: "#a14a0b" },
  { name: "Slate", hex: "#334155" },
];

/**
 * The surfaces an accent is drawn on, from apps/web/src/app/tokens.css (the web's tokens.spec.ts
 * checks these stay equal to that file). Light: page, surface, raised, sunken, field. Dark: same.
 */
export const LIGHT_SURFACES = [
  "#f5f7f9",
  "#ffffff",
  "#fafbfc",
  "#eef2f6",
  "#ffffff",
] as const;
export const DARK_SURFACES = [
  "#0b1220",
  "#131c2e",
  "#172235",
  "#1b2639",
  "#0f1829",
] as const;
const DARK_SURFACE = "#131c2e";
const DARK_INK = "#0b1220";

/** WCAG AA for normal text. */
export const MIN_TEXT_CONTRAST = 4.5;

const HEX = /^#[0-9a-f]{6}$/;

export function normalizeHex(value: string): string | null {
  const v = value.trim().toLowerCase();
  return HEX.test(v) ? v : null;
}

type Rgb = [number, number, number];

function rgb(hex: string): Rgb {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
}

function hexOf([r, g, b]: Rgb): string {
  return `#${[r, g, b]
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Rounded the way people read it, "5.47:1". */
export function formatRatio(ratio: number): string {
  return `${(Math.floor(ratio * 100) / 100).toFixed(2)}:1`;
}

/** The lowest ratio of `hex` against every light surface: what a link or selected item in that
 *  colour gets in the worst place it appears. */
export function lightContrast(hex: string): number {
  return Math.min(...LIGHT_SURFACES.map((s) => contrastRatio(hex, s)));
}

/**
 * Why an accent can't be saved, in words for the owner, or null if it can. The accent is used as
 * link and selected-item text on every light surface, and white text sits on it in buttons, so it
 * must reach 4.5:1 against all of them. The dark-theme accent is derived and always passes.
 */
export function accentProblem(value: string): string | null {
  const hex = normalizeHex(value);
  if (!hex)
    return "Enter a colour as # and six hex digits, for example #0f766e.";
  const ratio = lightContrast(hex);
  if (ratio < MIN_TEXT_CONTRAST)
    return `Too light to read: ${formatRatio(ratio)} on the page background, and it needs ${formatRatio(MIN_TEXT_CONTRAST)}. Choose a darker shade.`;
  return null;
}

function mix(a: string, b: string, t: number): string {
  const [x, y] = [rgb(a), rgb(b)];
  return hexOf([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t) as Rgb);
}

function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = rgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === r
      ? ((g - b) / d + (g < b ? 6 : 0)) / 6
      : max === g
        ? ((b - r) / d + 2) / 6
        : ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function fromHsl([h, s, l]: [number, number, number]): string {
  if (s === 0) return hexOf([l * 255, l * 255, l * 255]);
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };
  return hexOf([
    channel(h + 1 / 3) * 255,
    channel(h) * 255,
    channel(h - 1 / 3) * 255,
  ]);
}

export interface AccentTokens {
  accent: string;
  hover: string;
  ink: string;
  soft: string;
}

/**
 * The full accent family for both themes from the owner's one colour. Light uses the colour as
 * chosen; dark keeps its hue and lifts its lightness until it reads on every dark surface (the
 * light teal #0f766e is about 3:1 on the dark page). Soft fills are kept light or dark enough
 * that accent text on them still reaches 4.5:1.
 */
export function deriveAccentTokens(value: string): {
  light: AccentTokens;
  dark: AccentTokens;
} {
  const hex = normalizeHex(value) ?? DEFAULT_PHARMACY_APPEARANCE.accent;

  let lightSoft = mix(hex, "#ffffff", 0.9);
  for (
    let t = 0.9;
    contrastRatio(hex, lightSoft) < MIN_TEXT_CONTRAST && t < 1;
    t += 0.01
  )
    lightSoft = mix(hex, "#ffffff", t);
  const light: AccentTokens = {
    accent: hex,
    hover: mix(hex, "#000000", 0.15),
    ink: "#ffffff",
    soft: lightSoft,
  };

  const [h, s, l0] = toHsl(hex);
  const worstDark = (c: string) =>
    Math.min(...DARK_SURFACES.map((bg) => contrastRatio(c, bg)));
  let darkAccent = hex;
  for (let l = l0; worstDark(darkAccent) < 6 && l <= 0.92; l += 0.01)
    darkAccent = fromHsl([h, Math.min(s, 0.85), l]);
  const darkHover = fromHsl([
    h,
    Math.min(s, 0.85),
    Math.min(0.95, toHsl(darkAccent)[2] + 0.08),
  ]);
  let darkSoft = mix(DARK_SURFACE, darkAccent, 0.18);
  for (
    let t = 0.18;
    contrastRatio(darkAccent, darkSoft) < MIN_TEXT_CONTRAST && t > 0;
    t -= 0.01
  )
    darkSoft = mix(DARK_SURFACE, darkAccent, t);
  const dark: AccentTokens = {
    accent: darkAccent,
    hover: darkHover,
    ink:
      contrastRatio(DARK_INK, darkAccent) >= MIN_TEXT_CONTRAST
        ? DARK_INK
        : "#ffffff",
    soft: darkSoft,
  };
  return { light, dark };
}

/** Chart marks (bars, lines, slices) are not text: WCAG 1.4.11 asks 3:1 against what they sit on. */
export const MIN_CHART_CONTRAST = 3;

/** How many series colours a chart gets before it starts again. */
export const CHART_SERIES_COUNT = 6;

type Hsl = [number, number, number];

/**
 * Moves a colour's lightness (darker on light surfaces, lighter on dark ones) from `start` until
 * it reaches `min` against every surface. Hue and saturation stay, so a series keeps its identity.
 */
function fitLightness(
  [h, s]: Hsl,
  start: number,
  surfaces: readonly string[],
  dark: boolean,
  min = MIN_CHART_CONTRAST,
): string {
  const worst = (c: string) =>
    Math.min(...surfaces.map((bg) => contrastRatio(c, bg)));
  let l = start;
  let colour = fromHsl([h, s, l]);
  while (worst(colour) < min && l > 0.02 && l < 0.98) {
    l += dark ? 0.01 : -0.01;
    colour = fromHsl([h, s, l]);
  }
  return colour;
}

/**
 * The "distinct" chart colours: hues from the Okabe–Ito set (blue, vermilion, bluish green,
 * reddish purple, ochre) plus slate, which stay apart for the common colour blindnesses. They are
 * fixed, whatever the accent, and fitted to 3:1 in each theme.
 */
const DISTINCT_HUES: Hsl[] = [
  [202 / 360, 1, 0.35],
  [26 / 360, 1, 0.42],
  [164 / 360, 1, 0.31],
  [327 / 360, 0.45, 0.5],
  [41 / 360, 1, 0.33],
  [215 / 360, 0.16, 0.42],
];

/** The "accent" chart colours: the accent first, then its neighbours and one contrast hue. */
const ACCENT_OFFSETS: { dh: number; light: number; dark: number }[] = [
  { dh: 0, light: -1, dark: -1 }, // the accent itself (-1 = use the theme's accent lightness)
  { dh: 40 / 360, light: 0.48, dark: 0.7 },
  { dh: -40 / 360, light: 0.36, dark: 0.62 },
  { dh: 160 / 360, light: 0.45, dark: 0.68 },
  { dh: 100 / 360, light: 0.4, dark: 0.66 },
  { dh: 0, light: 0.42, dark: 0.66 }, // a neutral, desaturated below
];

export interface ChartSeries {
  light: string[];
  dark: string[];
}

export function distinctChartSeries(): ChartSeries {
  return {
    light: DISTINCT_HUES.map((c) =>
      fitLightness(c, c[2], LIGHT_SURFACES, false),
    ),
    // Fully saturated hues glare on a dark page, so dark keeps them softer.
    dark: DISTINCT_HUES.map(([h, sat, l]) =>
      fitLightness(
        [h, Math.min(sat, 0.7), l],
        Math.max(l, 0.55),
        DARK_SURFACES,
        true,
      ),
    ),
  };
}

/** The accent family for charts, in both themes, every colour at 3:1 on every surface. */
export function accentChartSeries(value: string): ChartSeries {
  const { light, dark } = deriveAccentTokens(value);
  const series = (
    accent: string,
    surfaces: readonly string[],
    isDark: boolean,
  ) => {
    const [h, s, l] = toHsl(accent);
    return ACCENT_OFFSETS.map((o, i) => {
      // The first series is the theme's accent exactly; it already reads at 4.5:1 or better.
      if (i === 0) return accent;
      // A grey accent already is the neutral, so its last series takes a far hue instead.
      const neutral = i === ACCENT_OFFSETS.length - 1 && s >= 0.2;
      const dh = i === ACCENT_OFFSETS.length - 1 && !neutral ? 200 / 360 : o.dh;
      const hue = (((h + dh) % 1) + 1) % 1;
      const sat = neutral
        ? Math.min(s, 0.14)
        : Math.min(Math.max(s, 0.4), isDark ? 0.7 : 0.85);
      const start = o.light < 0 ? l : isDark ? o.dark : o.light;
      return fitLightness([hue, sat, start], start, surfaces, isDark);
    });
  };
  return {
    light: series(light.accent, LIGHT_SURFACES, false),
    dark: series(dark.accent, DARK_SURFACES, true),
  };
}

function block(
  selector: string,
  t: AccentTokens,
  chart: string[],
  indent = "",
): string {
  const lines = [
    `--ui-accent: ${t.accent};`,
    `--ui-accent-hover: ${t.hover};`,
    `--ui-accent-ink: ${t.ink};`,
    `--ui-accent-soft: ${t.soft};`,
    `--ui-selected: ${t.soft};`,
    ...chart.map((c, i) => `--ui-chart-accent-${i + 1}: ${c};`),
  ];
  return `${indent}${selector} {\n${lines.map((l) => `${indent}  ${l}`).join("\n")}\n${indent}}`;
}

/**
 * The accent as a stylesheet. It mirrors tokens.css's three theme states with every selector one
 * `:root` more specific, so it wins wherever the page puts it (the pre-paint script may insert it
 * before the app's own stylesheets) and follows light/dark without any script. It carries the
 * accent chart colours too; which chart set a page uses is the `data-chart` attribute's job.
 */
export function pharmacyBrandCss(accent: string): string {
  const { light, dark } = deriveAccentTokens(accent);
  const chart = accentChartSeries(accent);
  return [
    block(":root:root", light, chart.light),
    `@media (prefers-color-scheme: dark) {\n${block(':root:root:not([data-theme="light"])', dark, chart.dark, "  ")}\n}`,
    block(':root:root[data-theme="dark"]', dark, chart.dark),
  ].join("\n");
}

export type AppearanceValidation =
  | { ok: true; value: PharmacyAppearanceSettings }
  | { ok: false; error: string };

/** Checks a full settings object as sent by the owner's form. */
export function validatePharmacyAppearance(
  input: unknown,
): AppearanceValidation {
  if (!input || typeof input !== "object")
    return { ok: false, error: "Appearance settings are missing." };
  const v = input as Record<string, unknown>;
  const accent = typeof v.accent === "string" ? normalizeHex(v.accent) : null;
  const problem = accentProblem(typeof v.accent === "string" ? v.accent : "");
  if (problem || !accent)
    return { ok: false, error: problem ?? "Choose an accent colour." };
  const pick = <T extends string>(
    key: string,
    allowed: readonly T[],
  ): T | null =>
    typeof v[key] === "string" &&
    (allowed as readonly string[]).includes(v[key] as string)
      ? (v[key] as T)
      : null;
  const sidebarStyle = pick("sidebarStyle", SIDEBAR_STYLES);
  const chartPalette = pick("chartPalette", CHART_PALETTES);
  const statusSet = pick("statusSet", STATUS_COLOUR_SETS);
  const counterTheme = pick("counterTheme", COUNTER_THEME_DEFAULTS);
  if (!sidebarStyle) return { ok: false, error: "Choose a sidebar style." };
  if (!chartPalette) return { ok: false, error: "Choose chart colours." };
  if (!statusSet) return { ok: false, error: "Choose a status colour set." };
  if (!counterTheme)
    return { ok: false, error: "Choose the counter app theme." };
  if (typeof v.counterThemeLocked !== "boolean")
    return { ok: false, error: "Say whether the counter theme is locked." };
  return {
    ok: true,
    value: {
      accent,
      sidebarStyle,
      chartPalette,
      statusSet,
      counterTheme,
      counterThemeLocked: v.counterThemeLocked,
    },
  };
}
