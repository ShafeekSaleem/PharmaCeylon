/**
 * Guard: dates and numbers are formatted the PharmaCeylon way, not the computer's way (UI1 #205,
 * docs/design/ui-redesign/README.md rule 6).
 *
 * `toLocaleString()` with no locale follows Windows, so a counter set to US English printed
 * 11/13/2026, 2:05:00 PM on a receipt. Every `toLocale*String` and
 * `new Intl.DateTimeFormat` / `NumberFormat` under src/ must pass `DISPLAY_LOCALE` from
 * @pharmaceylon/shared — or, better, use `formatDisplayDate` / `formatDisplayDateTime` /
 * `formatDisplayTime`, and money as `Rs` + `money()`.
 *
 * `"en-CA"` is allowed because it is how the code builds YYYY-MM-DD keys, never shown to a person.
 * Covers main (receipts, X-reports, dialogs) and the renderer. Specs are not scanned.
 */
import { describe, expect, it } from "@jest/globals";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = __dirname;
const CALL =
  /\.(?:toLocaleDateString|toLocaleTimeString|toLocaleString)\(|new Intl\.(?:DateTimeFormat|NumberFormat)\(/g;
const ALLOWED_FIRST_ARG = /^\s*(?:DISPLAY_LOCALE|"en-CA")\s*[,)]/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "test" ? [] : sources(p);
    return /\.(ts|tsx)$/.test(e.name) && !/\.(spec|test)\./.test(e.name)
      ? [p]
      : [];
  });
}

describe("counter formatting", () => {
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
});
