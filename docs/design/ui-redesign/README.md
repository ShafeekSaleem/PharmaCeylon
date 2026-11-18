# UI redesign: web back office and desktop counter

Epic UI1 [#205](https://github.com/ShafeekSaleem/PharmaCeylon/issues/205). This folder is the repo copy of the redesign spec, the same way `docs/design/desktop-app/` is the P2b spec. Where this folder doesn't redraw a desktop page, `docs/design/desktop-app/` still applies.

- **Mockups:** the private design canvas "PharmaCeylon UI review and redesign" (link in #205). Each screen there has a note listing today's issues and what changed. Light and dark PNG exports of the agreed screens are added here once Shafeek signs them off.
- **Decisions (17 Nov 2026):** see #205, "Decisions". In short: web selling is hidden by W2 #64, not by this epic; quick keys belong to this epic; Settings replaces the main sidebar; the owner sets one pharmacy brand for everyone; the counter theme has a back-office default and a cashier switch; inventory and the stock and buying pages come later.

## Tokens

One semantic set for both apps: [`apps/web/src/app/tokens.css`](../../../apps/web/src/app/tokens.css). The web imports it from `globals.css`, and the desktop gets it through the same import.

| Token                                           | Use                                                          |
| ----------------------------------------------- | ------------------------------------------------------------ |
| `--ui-surface-page`                             | Page and window background (desktop canvas)                  |
| `--ui-surface`                                  | Cards, panels, the sidebar, the desktop title bar            |
| `--ui-surface-raised`                           | A panel inside a card, table header rows                     |
| `--ui-surface-sunken`                           | Wells, inactive segments, code and muted panels              |
| `--ui-field`                                    | Text inputs and selects                                      |
| `--ui-line` / `--ui-line-strong`                | Dividers and borders; strong for inputs and outlined buttons |
| `--ui-text` / `--ui-text-2` / `--ui-text-muted` | Body, secondary, hints and table headers                     |
| `--ui-accent`, `-hover`, `-ink`, `-soft`        | The pharmacy brand colour. Ink is the text on an accent fill |
| `--ui-selected`                                 | The selected row, nav item or chip                           |
| `--ui-{ok,warn,danger,info}`                    | Solid status: icons, dots, bars, count badges                |
| `--ui-{ok,warn,danger,info}-ink`                | Status text                                                  |
| `--ui-{ok,warn,danger,info}-soft` / `-line`     | Status chip fill and border                                  |
| `--ui-on-status`                                | Text on a solid status fill (count badges)                   |

The older names still work and now follow this set. On the web, `--pc-page-bg`, `--pc-card-bg`, `--pc-foreground`, `--pc-muted-fg`, `--pc-border`, `--pc-alert-*`, and the danger, warning, success and info `--pc-tone-*` point at `--ui-*`. On the desktop, `--pos-canvas`, `--pos-surface*`, `--pos-text*`, `--pos-line*`, and the `--pos-{ok,warn,bad,info}*` tokens do the same. New and redesigned components should use `--ui-*` directly. Chart series, prescription purple and the desktop tile colours stay in their own app's tokens.

### Themes and status sets

- **Theme:** an explicit choice stamps `data-theme="light|dark"` on `<html>`; "match device" stamps nothing and `prefers-color-scheme` decides. The dark values are declared twice, under the media query and under `[data-theme="dark"]`, and the test keeps the two copies identical.
- **Status set:** `data-status-set="colour-blind"` on `<html>` switches danger, warning and ok to orange, yellow and blue, which differ in lightness as well as hue. With no attribute you get the Standard set. The owner's choice (Settings › Appearance) will set it in the pharmacy brand PR.

### Contrast

[`apps/web/src/app/tokens.spec.ts`](../../../apps/web/src/app/tokens.spec.ts) reads `tokens.css` and checks four palettes: light, dark, and each of those with the colour-blind set.

- Text, secondary text, muted text and accent text: at least 4.5:1 on every surface.
- Accent ink on the accent and on its hover: 4.5:1. Text on the selected fill: 4.5:1.
- Status ink: 4.5:1 on its soft fill, on the surface and on the page.
- Solid status marks: 3:1 on the surface (non-text contrast).

Every `--ui-*` value is a 6-digit hex so the test can read it without a browser. A colour that fails the test can't be merged.

What changed on 18 Nov 2026 to pass:

|                                             | Before                         | After                          |
| ------------------------------------------- | ------------------------------ | ------------------------------ |
| Web muted text on muted panels              | `#64748b` on `#f1f5f9`, 4.34:1 | `#56617a` on `#eef2f6`, 5.51:1 |
| Desktop hint text, light                    | `#8391a7` on white, 3.19:1     | `#56617a`, 6.20:1              |
| Desktop hint text, dark                     | `#6b7a93` on `#121b2c`, 3.96:1 | `#9aa8bd` on `#131c2e`, 7.06:1 |
| Default teal accent (links, selected items) | `#0d9488` on white, 3.74:1     | `#0f766e`, 5.47:1              |
| Cyan accent preset                          | `#0891b2` on white, 3.68:1     | `#0e7490`, 5.36:1              |

## Rules

1. **Colour only the exception.** Late, low, zero, inactive, blocked. Normal states ("Active", "In stock", "Synced") are plain text or not shown at all. If most rows on a page are coloured, nothing stands out.
2. **Status is never colour alone.** Every coloured chip, dot or bar carries a word ("3 days late", "Low · 14"). This is what makes the colour-blind set safe, and it's what a screen reader reads.
3. **Components never hard-code colours.** Use a token. A literal hex stays light-on-dark in the dark theme, which is the bug the token layer exists to prevent. Print styles are the one exception.
4. **Text on an accent fill uses the accent ink**, not `#fff`. The dark accent is bright, so white text on it fails contrast.
5. **One scope control per page.** The top-bar branch switch decides what every card shows.
6. **Dates in day-month order** (18 Nov 2026), currency as LKR on the web and Rs on the desktop.

## Not done yet

These items in #205's Phase 1 come in later PRs:

- **Theme switch** in the web top bar and the desktop title bar, with the desktop window buttons following the chosen theme.
- **Pharmacy brand settings on the server:** accent, sidebar style, chart palette, status set, and the counter theme default and lock.
- **Web shell and the shared list pattern.**
- **Sweep of the remaining hard-coded colours.** About 70 literal `#fff` values in web CSS modules, many of them white text on an accent fill that fails in dark. Eight `--pc-*` names that are referenced but never defined (`--pc-surface-2`, `--pc-rule`, `--pc-border-subtle`, `--pc-radius`, `--pc-radius-lg`, `--pc-shadow-sm`, `--pc-font-mono`, `--pc-alert-danger-bg`), which always fall back to their literal. About 115 literals in the desktop renderer, left until the P4 desktop work settles.

## Screenshots

`screenshots/pr1-tokens/` holds before and after captures for the token PR. Web pages are at 1440 × 900 (before and after) and 1366 × 768 (after), signed in as the seed owner. Desktop pages are at 1366 × 768 and 1024 × 640, from the screenshot fixture. Each is in light and dark. The changes are deliberately small: muted text and links get darker on light, muted text gets lighter on dark, and the default teal is one step deeper.
