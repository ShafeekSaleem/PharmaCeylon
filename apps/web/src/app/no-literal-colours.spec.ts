/**
 * Guard: CSS modules use tokens, not literal colours (Epic UI1 #205, Phase 1;
 * docs/design/ui-redesign/README.md rule 3).
 *
 * A literal hex stays light-on-dark in the dark theme and ignores the owner's brand accent, so
 * every `*.module.css` under src/ is scanned for hex, rgb()/rgba(), hsl()/hsla() and the named
 * colours white/black, and the test fails on any that is not in ALLOWED below.
 *
 * Not checked, by rule:
 * - `@media print` blocks: paper is white whatever the screen theme.
 * - Shadow properties (box-shadow, text-shadow, filter): a shadow is depth, not a surface, line,
 *   text, accent or status colour.
 * - globals.css and tokens.css, which are not modules: that is where the literals live.
 *
 * To fix a failure, use a token (`--ui-*`, or a `--pc-*` alias in globals.css). If a colour has
 * no token and genuinely should not follow the theme (a chart series, prescription purple),
 * add an entry to ALLOWED with the reason.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = join(__dirname, "..");

type Allowed = {
  /** Path under src/, forward slashes. */
  file: string;
  /** Rule selector, whitespace collapsed, or "*" for every rule in the file. */
  selector: string;
  /** Property, or "*" for every property. */
  property: string;
  reason: string;
};

const CHART = "Chart series fill: text sits on a data colour, not on a themed surface.";

const ALLOWED: Allowed[] = [
  // Charts.
  {
    file: "app/(app)/reports/reports.module.css",
    selector: ".treemapTileContent",
    property: "color",
    reason: CHART,
  },
  {
    file: "app/(app)/reports/reports.module.css",
    selector: ".treemapTile",
    property: "color",
    reason: CHART,
  },
  {
    file: "app/(app)/reports/reports.module.css",
    selector: ".catHeatCell",
    property: "color",
    reason: CHART,
  },
];

const SKIPPED_PROPERTIES = new Set(["box-shadow", "text-shadow", "filter"]);

const LITERAL =
  /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(|(?:^|[\s,(])(?:white|black)(?=$|[\s,);])/i;

export type Finding = { file: string; selector: string; property: string; value: string };

function moduleFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : moduleFiles(path);
    return name.endsWith(".module.css") ? [path] : [];
  });
}

/** Removes every `@media print { … }` block, braces matched. */
function withoutPrint(css: string): string {
  let out = css;
  for (;;) {
    const at = out.search(/@media\s+print\b[^{]*\{/);
    if (at < 0) return out;
    let i = out.indexOf("{", at) + 1;
    for (let depth = 1; depth > 0 && i < out.length; i++) {
      if (out[i] === "{") depth++;
      else if (out[i] === "}") depth--;
    }
    out = out.slice(0, at) + out.slice(i);
  }
}

/** Every declaration holding a literal colour, with the selector of the rule it sits in. */
export function literalColours(file: string, source: string): Finding[] {
  const css = withoutPrint(source.replace(/\/\*[\s\S]*?\*\//g, ""));
  const findings: Finding[] = [];
  const selectors: string[] = [];
  let chunk = "";
  for (const ch of css) {
    if (ch === "{") {
      selectors.push(chunk.trim().replace(/\s+/g, " "));
      chunk = "";
    } else if (ch === "}" || ch === ";") {
      const decl = chunk.trim();
      const colon = decl.indexOf(":");
      if (colon > 0 && selectors.length > 0) {
        const property = decl.slice(0, colon).trim().toLowerCase();
        const value = decl.slice(colon + 1).trim();
        if (!SKIPPED_PROPERTIES.has(property) && LITERAL.test(value)) {
          findings.push({ file, selector: selectors[selectors.length - 1], property, value });
        }
      }
      chunk = "";
      if (ch === "}") selectors.pop();
    } else {
      chunk += ch;
    }
  }
  return findings;
}

function allows(entry: Allowed, f: Finding): boolean {
  return (
    entry.file === f.file &&
    (entry.selector === "*" || entry.selector === f.selector) &&
    (entry.property === "*" || entry.property === f.property)
  );
}

describe("CSS modules use colour tokens", () => {
  const findings = moduleFiles(SRC).flatMap((path) =>
    literalColours(relative(SRC, path).split(sep).join("/"), readFileSync(path, "utf8")),
  );

  it("finds the module files", () => {
    expect(findings.length).toBeGreaterThan(0); // the allow-listed ones, at least
  });

  it("has no literal colour outside the allow-list", () => {
    const offenders = findings
      .filter((f) => !ALLOWED.some((a) => allows(a, f)))
      .map((f) => `${f.file}  ${f.selector} { ${f.property}: ${f.value} }`);
    expect(offenders).toEqual([]);
  });

  it("has no stale allow-list entry", () => {
    const stale = ALLOWED.filter((a) => !findings.some((f) => allows(a, f))).map(
      (a) => `${a.file}  ${a.selector} { ${a.property} }`,
    );
    expect(stale).toEqual([]);
  });
});

describe("literalColours", () => {
  it("flags hex, rgb, hsl and named colours", () => {
    const css = `.a { color: #fff; } .b { background: rgba(0, 0, 0, 0.1); }
      .c { border-color: hsl(10 20% 30%); } .d { background: color-mix(in srgb, red 5%, white); }`;
    expect(literalColours("x", css).map((f) => f.selector)).toEqual([".a", ".b", ".c", ".d"]);
  });

  it("ignores tokens, white-space, shadows, comments and print", () => {
    const css = `/* #fff */ .a { color: var(--ui-text); white-space: nowrap; }
      .b { box-shadow: 0 1px 2px rgba(0,0,0,.1); }
      @media print { .c { color: #000; } .d { background: #fff; } }
      .e:hover { color: currentColor; }`;
    expect(literalColours("x", css)).toEqual([]);
  });

  it("keeps the selector inside other at-rules", () => {
    expect(literalColours("x", "@media (max-width: 900px) { .a { color: #123456; } }")).toEqual([
      { file: "x", selector: ".a", property: "color", value: "#123456" },
    ]);
  });
});
