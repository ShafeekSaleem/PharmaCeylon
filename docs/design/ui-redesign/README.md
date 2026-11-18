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
- **Status set:** `data-status-set="colour-blind"` on `<html>` switches danger, warning and ok to orange, yellow and blue, which differ in lightness as well as hue. With no attribute you get the Standard set. The owner chooses it in the pharmacy brand (below).

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

## Theme switch

- **Web:** a sun/moon button in the top bar on every page flips what is showing and saves it as that person's choice in this browser (the same preferences Settings › Appearance edits). Under "Match device" a click leaves it and picks the other look; the Appearance page offers Match device to go back. The choice is applied before first paint (`THEME_BOOTSTRAP_SCRIPT`), which now reads the preferences of whoever saved last, so a shared browser shows the right person's theme.
- **Desktop:** a sun/moon button in the title bar. Main sets Electron's `nativeTheme.themeSource`, so the page's `prefers-color-scheme` and the Windows minimise, maximise and close buttons change together, and saves the choice to `counter-theme.json` in the app's data folder on this computer. With nothing saved, the counter follows Windows. The back-office default ("light/dark/follow Windows") and the lock that hides the button come with the pharmacy brand settings.
- Screenshots: `screenshots/pr2-theme-switch/`.

## Pharmacy brand

One appearance for everyone at the pharmacy, set by an owner on Settings › Appearance › Pharmacy brand. Light or dark, density and text size stay each person's own; the personal accent swatches are gone.

- **Stored on the server:** `tenant_appearance`, one row per tenant: `accent`, `sidebarStyle` (light, tinted, dark), `chartPalette`, `statusSet` (standard, colour-blind), `counterTheme` (system, light, dark), `counterThemeLocked`, and a `version`. No row means the PharmaCeylon defaults at version 0.
- **API:** `GET /tenant/appearance` for anyone signed in (every page needs it to draw). `PUT /tenant/appearance` with `{ expectedVersion, appearance }`: owners only, even though the guard key is `tenant.management`; a stale `expectedVersion` is a 409; every save is audited as `tenant.appearance_updated` with the before and after.
- **One contrast rule, two places:** [`packages/shared/src/pharmacy-appearance.ts`](../../../packages/shared/src/pharmacy-appearance.ts). `accentProblem` refuses an accent below 4.5:1 on any light surface, and the API and the form show the same sentence. `deriveAccentTokens` builds hover, ink and soft for light, and a lifted accent for dark that reaches 6:1 on every dark surface. The surface lists there are checked against `tokens.css` by `tokens.spec.ts`.
- **On the web:** a custom accent becomes a `<style id="pc-brand">` with the same three selectors as `tokens.css`, one `:root` more specific, so it follows light and dark without script. The status set and sidebar style are `data-status-set` and `data-sidebar` on `<html>`. The last brand is cached in this browser and redrawn before first paint (`BRAND_BOOTSTRAP_SCRIPT`), then replaced by the server copy. The default teal adds no stylesheet. An owner's choices preview live and are put back if they leave without saving.
- **Sidebar styles:** Tinted sits on the accent's soft fill; Dark uses the dark surface in either theme.
- **Not wired yet:** the chart palette is stored and validated but has no control until the charts read it.
- **Counter app theme** (Match Windows, Light, Dark) and **Lock it on every counter** are on the same card.
- **Logo:** the PharmaCeylon mark keeps its own teal gradient whatever the accent.
- **On the desktop counter:** main reads `GET /tenant/appearance` (a counter route) when someone signs in, by password or PIN, and every five minutes while someone is signed in, and keeps it in `counter-brand.json` in the app's data folder. So a counter that restarts offline, or before anyone signs in, still has the pharmacy's look and keeps the lock. Main builds the accent stylesheet with the same shared code as the web, and the title bar draws it with the status set (`counter-brand.ts`, read every 30 seconds).
- **Counter theme default and lock:** the owner's `counterTheme` is where a counter starts. A cashier's switch on that computer wins until the owner locks it. While it is locked, the owner's theme is shown, the switch is hidden, and main refuses a change. The cashier's last choice is kept, so unlocking brings it back.
- **Receipt header:** the branch name prints in the accent over a 2px rule in the same colour. Every accent an owner can save reaches 4.5:1 on white, so a one-colour thermal printer prints it as solid dark text.
- **Desktop soft fills** (`--pos-primary-soft`, `-soft-2`) now mix from the accent instead of a fixed teal. The other literal teals in the desktop CSS wait for the colour sweep below.
- Screenshots: `screenshots/pr3-brand-settings/` (web) and `screenshots/pr4-desktop-brand/` (counter and receipt). The counter shots stand in a fake bridge for main. The appearance endpoint was stubbed in the browser for these, because the shared dev database is behind on migrations.

## Not done yet

These items in #205's Phase 1 come in later PRs:

- **Chart palette:** an owner control once the dashboard charts read it.
- **Web shell and the shared list pattern.**
- **Sweep of the remaining hard-coded colours.** About 70 literal `#fff` values in web CSS modules, many of them white text on an accent fill that fails in dark. Eight `--pc-*` names that are referenced but never defined (`--pc-surface-2`, `--pc-rule`, `--pc-border-subtle`, `--pc-radius`, `--pc-radius-lg`, `--pc-shadow-sm`, `--pc-font-mono`, `--pc-alert-danger-bg`), which always fall back to their literal. About 115 literals in the desktop renderer, left until the P4 desktop work settles.

## Screenshots

`screenshots/pr1-tokens/` holds before and after captures for the token PR. Web pages are at 1440 × 900 (before and after) and 1366 × 768 (after), signed in as the seed owner. Desktop pages are at 1366 × 768 and 1024 × 640, from the screenshot fixture. Each is in light and dark. The changes are deliberately small: muted text and links get darker on light, muted text gets lighter on dark, and the default teal is one step deeper.
