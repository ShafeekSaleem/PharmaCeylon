/**
 * Guard for Epic UI1 #205: counter components never hard-code a colour. A literal stays the same in
 * light and dark, ignores the colour-blind status set and ignores the pharmacy's accent, so every
 * colour goes through a token: `--ui-*` (apps/web/src/app/tokens.css) or the counter's own
 * `--pos-*` (tokens.css here). tokens.css is the one renderer file that may hold literals.
 *
 * If this fails on a colour you need, add a named token to tokens.css (with its dark value) and use
 * that. ALLOWED is for a literal that truly can't be a token, with the reason next to it.
 */
import { describe, expect, it } from "@jest/globals";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = __dirname;

/** file (relative to src/renderer/src, forward slashes) → literals it may keep, and why. */
const ALLOWED: Record<string, string[]> = {};

const NAMED = [
  "white",
  "black",
  "red",
  "green",
  "blue",
  "gray",
  "grey",
  "silver",
  "orange",
  "yellow",
  "purple",
  "violet",
  "teal",
  "navy",
  "maroon",
  "olive",
  "lime",
  "aqua",
  "fuchsia",
  "cyan",
  "magenta",
  "pink",
  "indigo",
];

const HEX =
  /(?<![\w-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
const FN = /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\([^)]*\)/g;
const NAMED_RE = new RegExp(
  `(?<![\\w-])(?:${NAMED.join("|")})(?![\\w-])`,
  "gi",
);
// Web-only palette names bypass the shared set on the counter. Size tokens are fine.
const PC_COLOUR = /var\(--pc-(?!radius|space|font)[\w-]+/g;

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
}

/** Literal colours in a stylesheet's declaration values (selectors and comments are skipped). */
export function cssColourLiterals(css: string): string[] {
  const found: string[] = [];
  // Declarations live in the innermost blocks; selectors and at-rule preludes sit outside them.
  for (const block of stripCssComments(css).matchAll(/\{([^{}]*)\}/g)) {
    for (const m of block[1]!.matchAll(/([\w-]+)\s*:\s*([^;]+)/g)) {
      if (/^(?:composes|content|grid-template-areas|grid-area)$/.test(m[1]!))
        continue;
      // Drop token names (so --pos-t-cyan isn't "cyan") but keep any fallback after the comma.
      const value = m[2]!.replace(/var\(\s*--(?!pc-)[\w-]+/g, "var(");
      for (const re of [HEX, FN, NAMED_RE, PC_COLOUR]) {
        for (const hit of value.matchAll(re)) found.push(hit[0]);
      }
    }
  }
  return found;
}

/**
 * Literal colours in a component's string literals (inline styles, tone maps). Named colours are
 * left to the stylesheets: in code, "blue" or "violet" is a tone key that picks a token.
 */
export function tsxColourLiterals(source: string): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  const found: string[] = [];
  for (const m of code.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g)) {
    const text = m[1] ?? m[2] ?? m[3] ?? "";
    if (
      /^\s*#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\s*$/.test(text)
    )
      found.push(text.trim());
    for (const hit of text.matchAll(FN)) found.push(hit[0]);
    for (const hit of text.matchAll(PC_COLOUR)) found.push(hit[0]);
  }
  return found;
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

const files = walk(ROOT)
  .map((f) => relative(ROOT, f).replace(/\\/g, "/"))
  .filter((f) => f !== "tokens.css")
  .filter(
    (f) => /\.css$/.test(f) || (/\.tsx?$/.test(f) && !/\.spec\.tsx?$/.test(f)),
  );

describe("renderer colour literals", () => {
  it("scans the renderer's stylesheets and components", () => {
    expect(files.filter((f) => f.endsWith(".css")).length).toBeGreaterThan(15);
    expect(files).toContain("Sell.module.css");
    expect(files).toContain("Sell.tsx");
  });

  it.each(files)("%s uses tokens, not literal colours", (file: string) => {
    const text = readFileSync(join(ROOT, file), "utf8");
    const found = file.endsWith(".css")
      ? cssColourLiterals(text)
      : tsxColourLiterals(text);
    const allowed = ALLOWED[file] ?? [];
    expect(found.filter((c) => !allowed.includes(c))).toEqual([]);
  });

  it("has no allow-list entries for files that no longer need them", () => {
    for (const [file, literals] of Object.entries(ALLOWED)) {
      const text = readFileSync(join(ROOT, file), "utf8");
      const found = file.endsWith(".css")
        ? cssColourLiterals(text)
        : tsxColourLiterals(text);
      for (const c of literals) expect(found).toContain(c);
    }
  });
});

describe("the scanner", () => {
  it("finds hex, colour functions, named colours and web palette names in CSS values", () => {
    const css = `
      /* #205 and rgba(1, 2, 3, 0.5) in a comment are fine */
      .a { color: #fff; background: rgba(255, 255, 255, 0.18); }
      .b { border: 1px solid white; fill: #0d9488; }
      .c { background: color-mix(in srgb, hsl(170 80% 30%) 20%, transparent); }
      .d { color: var(--pc-foreground); border-radius: var(--pc-radius-md); }
    `;
    expect(cssColourLiterals(css)).toEqual([
      "#fff",
      "rgba(255, 255, 255, 0.18)",
      "white",
      "#0d9488",
      "hsl(170 80% 30%)",
      "var(--pc-foreground",
    ]);
  });

  it("leaves tokens, keywords and look-alike names alone", () => {
    const css = `
      #root .x { color: var(--pos-t-cyan); white-space: nowrap; }
      .y { background: color-mix(in srgb, var(--pos-primary) 13%, transparent); }
      .z { color: currentColor; border-color: inherit; outline: none; }
    `;
    expect(cssColourLiterals(css)).toEqual([]);
  });

  it("finds colours in component strings but not issue numbers or receipt numbers", () => {
    const tsx = `
      // see #205
      const a = { color: "#ffffff", background: 'rgba(0, 0, 0, 0.4)' };
      const b = { color: "var(--pc-foreground)" };
      const c = "Receipt #1234";
      const d = { "--c": "var(--pos-t-amber)" };
      const e = { tone: "violet" };
    `;
    expect(tsxColourLiterals(tsx)).toEqual([
      "#ffffff",
      "rgba(0, 0, 0, 0.4)",
      "var(--pc-foreground",
    ]);
  });
});
