/**
 * Guard: dates and numbers are formatted the PharmaCeylon way, not the computer's way (UI1 #205,
 * docs/design/ui-redesign/README.md rule 6).
 *
 * `toLocaleDateString()` with no locale follows the browser, so a till set to US English printed
 * 11/13/2026 and "Nov 13" beside "13 Nov 2026" on the next screen. Every `toLocale*String` and
 * `new Intl.DateTimeFormat` / `NumberFormat` under src/ must pass `DISPLAY_LOCALE` from
 * @pharmaceylon/shared — or, better, use `formatDisplayDate` / `formatDisplayDateTime` /
 * `formatDisplayTime` / `formatMoney`.
 *
 * `"en-CA"` is allowed because it is how the code builds YYYY-MM-DD keys, never shown to a person.
 * Specs and test helpers are not scanned.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = join(__dirname, "..");
const CALL =
  /\.(?:toLocaleDateString|toLocaleTimeString|toLocaleString)\(|new Intl\.(?:DateTimeFormat|NumberFormat)\(/g;
const ALLOWED_FIRST_ARG = /^\s*(?:DISPLAY_LOCALE|"en-CA")\s*[,)]/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "test-utils" ? [] : sources(p);
    return /\.(ts|tsx)$/.test(e.name) && !/\.(spec|test)\./.test(e.name)
      ? [p]
      : [];
  });
}

it("passes DISPLAY_LOCALE to every date and number formatter", () => {
  const offenders: string[] = [];
  for (const file of sources(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(CALL)) {
      const rest = text.slice(m.index! + m[0].length);
      if (ALLOWED_FIRST_ARG.test(rest)) continue;
      const line = text.slice(0, m.index).split("\n").length;
      offenders.push(`${relative(SRC, file).split(sep).join("/")}:${line}`);
    }
  }
  expect(offenders).toEqual([]);
});
