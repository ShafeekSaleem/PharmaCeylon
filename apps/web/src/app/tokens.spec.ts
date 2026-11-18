/**
 * Contrast check over the semantic token set (Epic UI1 #205, Phase 1).
 *
 * Reads tokens.css as text, so it needs no browser: every `--ui-*` value is a 6-digit hex by rule.
 * Four palettes are built the way the cascade builds them (light, dark, and each with the
 * colour-blind status set) and every text/surface pair is held to WCAG AA.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(__dirname, "tokens.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

type Palette = Record<string, string>;

/** The declarations of the first block whose selector is exactly `selector`. */
function block(selector: string): Palette {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`tokens.css has no block for ${selector}`);
  const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
  const out: Palette = {};
  for (const m of body.matchAll(/(--ui-[a-z0-9-]+)\s*:\s*([^;]+);/g))
    out[m[1]] = m[2].trim();
  return out;
}

const light = block(":root");
const dark = block(':root[data-theme="dark"]');
const darkMedia = block(':root:not([data-theme="light"])');
const cbLight = block(':root[data-status-set="colour-blind"]');
const cbDark = block(
  ':root[data-theme="dark"][data-status-set="colour-blind"]',
);
const cbDarkMedia = block(
  ':root:not([data-theme="light"])[data-status-set="colour-blind"]',
);

const palettes: Record<string, Palette> = {
  light,
  dark: { ...light, ...dark },
  "light, colour-blind": { ...light, ...cbLight },
  "dark, colour-blind": { ...light, ...dark, ...cbLight, ...cbDark },
};

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const SURFACES = [
  "surface-page",
  "surface",
  "surface-raised",
  "surface-sunken",
  "field",
];
const STATUSES = ["ok", "warn", "danger", "info"];

/** [foreground, background, minimum ratio] by token name, without the `--ui-` prefix. */
const PAIRS: [string, string, number][] = [
  ...["text", "text-2", "text-muted", "accent"].flatMap((fg) =>
    SURFACES.map((bg): [string, string, number] => [fg, bg, 4.5]),
  ),
  ["accent", "accent-soft", 4.5],
  ["accent", "selected", 4.5],
  ["accent-ink", "accent", 4.5],
  ["accent-ink", "accent-hover", 4.5],
  ["text", "selected", 4.5],
  ...STATUSES.flatMap((s): [string, string, number][] => [
    [`${s}-ink`, `${s}-soft`, 4.5],
    [`${s}-ink`, "surface", 4.5],
    [`${s}-ink`, "surface-page", 4.5],
    // Icons, dots and bars are non-text: 3:1 (WCAG 1.4.11).
    [s, "surface", 3],
  ]),
  // Count badges: a solid danger fill with a number on it.
  ["on-status", "danger", 4.5],
];

describe("tokens.css", () => {
  it("uses 6-digit hex for every semantic value", () => {
    for (const [name, p] of Object.entries(palettes)) {
      for (const [k, v] of Object.entries(p)) {
        expect(`${name} ${k}: ${v}`).toMatch(/: #[0-9a-f]{6}$/);
      }
    }
  });

  it("declares the same tokens in light and dark", () => {
    expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort());
    expect(Object.keys(cbDark).sort()).toEqual(Object.keys(cbLight).sort());
  });

  it("keeps the follow-the-device dark blocks identical to the explicit dark blocks", () => {
    expect(darkMedia).toEqual(dark);
    expect(cbDarkMedia).toEqual(cbDark);
  });

  for (const [name, p] of Object.entries(palettes)) {
    describe(name, () => {
      it.each(PAIRS)("--ui-%s on --ui-%s reaches %s:1", (fg, bg, min) => {
        const ratio = contrast(p[`--ui-${fg}`], p[`--ui-${bg}`]);
        expect(Math.round(ratio * 100) / 100).toBeGreaterThanOrEqual(min);
      });
    });
  }
});
