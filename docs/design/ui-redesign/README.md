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
- **Chart colours:** six series colours, `--pc-chart-1` … `--pc-chart-6`, in two sets. **Brand colours** (`--ui-chart-accent-*`) start from the accent: the accent itself, two neighbouring hues, a contrast hue, a fifth hue and a neutral. **Distinct colours** (`--ui-chart-distinct-*`) are fixed Okabe–Ito hues that stay apart for the common colour blindnesses. The owner picks one with "Chart colours" on the card, and the web marks the choice with `data-chart="distinct"` on `<html>`. Every series colour reaches 3:1 on every surface in both themes (charts are not text, so WCAG 1.4.11's 3:1 applies). `tokens.spec.ts` checks the defaults in `tokens.css` against `accentChartSeries` and `distinctChartSeries` in the shared package, and the shared tests check every preset and edge-case accent. The branch, payment-mix, category-mix, branch-sales and cashier palettes use them, and so do the dashboard's single-series charts. Semantic colours (danger, expiry, ageing buckets) keep their own tones.
- **Counter app theme** (Match Windows, Light, Dark) and **Lock it on every counter** are on the same card.
- **Logo:** the PharmaCeylon mark keeps its own teal gradient whatever the accent.
- **On the desktop counter:** main reads `GET /tenant/appearance` (a counter route) when someone signs in, by password or PIN, and every five minutes while someone is signed in, and keeps it in `counter-brand.json` in the app's data folder. So a counter that restarts offline, or before anyone signs in, still has the pharmacy's look and keeps the lock. Main builds the accent stylesheet with the same shared code as the web, and the title bar draws it with the status set (`counter-brand.ts`, read every 30 seconds).
- **Counter theme default and lock:** the owner's `counterTheme` is where a counter starts. A cashier's switch on that computer wins until the owner locks it. While it is locked, the owner's theme is shown, the switch is hidden, and main refuses a change. The cashier's last choice is kept, so unlocking brings it back.
- **Receipt header:** the branch name prints in the accent over a 2px rule in the same colour. Every accent an owner can save reaches 4.5:1 on white, so a one-colour thermal printer prints it as solid dark text.
- **Desktop soft fills** (`--pos-primary-soft`, `-soft-2`) now mix from the accent instead of a fixed teal.
- Screenshots: `screenshots/pr-chart-palette/` (dashboard with Teal and Plum brand colours and the distinct set), `screenshots/pr3-brand-settings/` (web) and `screenshots/pr4-desktop-brand/` (counter and receipt). The counter shots stand in a fake bridge for main. The appearance endpoint was stubbed in the browser for these, because the shared dev database is behind on migrations.

## List pattern

One way to show a list of records, built with Products first and adopted later by Inventory, Purchasing and the other stock and buying pages. The pieces live in `apps/web/src/components/ui/`:

| Piece                                    | What it does                                                                                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `DataTable` with `variant="list"`        | 44px rows, about 36px when the person picks compact density (`data-density="compact"` on `<html>`). `--ui-*` colours only.                       |
| `minTableWidth` on the list variant      | The narrowest the table gets. Below it the table scrolls sideways inside its own box; the page never scrolls sideways, and rows don't turn into cards. |
| `FilterChips`                            | Quick filters above the list. Every chip is neutral and carries its count; only the applied filter is filled (accent and accent ink). None is filled when the list is filtered some other way. |
| `rowMenuColumn(getActions, rowLabel)`    | The one row-actions column: a single menu per row, flush right, named "Actions for {row}". A row with nothing to do has an empty cell.           |
| `RowMenu` / `orderRowMenuActions`        | Destructive actions always go last, behind a divider, so Delete is never next to Edit, whatever order the caller passes.                        |

Rules for a page moving onto it:

- Use `variant="list"` and give every column but one a `width` (with `fixedLayout`) so pages of results don't reflow.
- Put one action in each row's menu per thing a person can do to that row. A row's single next step (Add, on the Reference catalog) can stay a button.
- Show a cell only when it says something: leave it blank rather than repeating another column, and show only exceptional states (rule 1).
- The `variant="default"` table is unchanged for pages not moved yet, including its phone card layout.

### Products

- 13 rows show at 1440 × 900 and 9 at 1366 × 768 (25 per page; the rest scroll). Before, it was 5 and 2, because each row was about 107px tall. The other two rows of the "about 15" target sit in the page chrome above the list (top bar, breadcrumb, page header), which the web shell PR reworks.
- Every value is one line, cut with an ellipsis (Form / Strength has the full text as a tooltip). The product cell is the one with two lines.
- The product name has the generic name under it on a muted line. When the Brand column is hidden, a brand that differs from the name joins that line.
- One schedule badge: **OTC** (plain muted text), **Rx · II B** (outlined), **Controlled · III** (outlined on the sunken fill). It replaces the Rx tag, the "Prescription required" chip and the plain Schedule column. None of the three is coloured, because a prescription medicine isn't an exception in a pharmacy.
- Brand is blank when it only repeats the name; SKU is blank when it only repeats the registration number (register imports).
- No thumbnail column until products have real images. The category chip under the name is gone too; categories stay in the filters and on the product page.
- Stock is a number with a short note ("Reorder at 20"). Only zero ("Out of stock", danger ink) and low ("Low · reorder at 20", warning ink) are coloured, and both say so in words.
- Status shows only **Inactive**.
- Actions: one menu with Edit product, then Delete product behind a divider.
- Not yet in the stock note: batches, nearest expiry and last sold. The list endpoint doesn't return them, and this PR changes no data.
- An OTC product shows plain "OTC" even when it has a schedule; the schedule is in the tooltip.
- Screenshots: `screenshots/pr-list-pattern/`, before and after, light and dark, at 1440 × 900, 1366 × 768 and 390 × 844. No page scroll sideways at any of them; at 390 px the table scrolls inside its box.

## Web colour sweep

The web CSS modules now take every surface, line, text, accent and status colour from a token (104 literal colours before, 35 after, all on the allow-list below).

- **Which token:** text on an accent fill uses `--pc-btn-primary-text` (the accent ink); text on a solid tone fill (role avatars, rank dots) uses `--pc-on-tone`. Text on the brand gradient, the fixed accent preset swatches and the photo scrim uses `--pc-brand-text`, white in both themes, because those fills don't change with the theme. Tints that mixed into `white` mix into `--pc-card-bg`, so they darken in dark. The onboarding journey panel sits on the accent, so its text and its translucent rings are mixed from the accent ink.
- **Fallbacks removed:** `var(--token, #fff)` and the like are now `var(--token)`, so a missing token shows up instead of hiding behind a light-theme literal.
- **The eight undefined names** are defined in `globals.css`: `--pc-surface-2` (sunken surface), `--pc-rule` and `--pc-border-subtle` (line), `--pc-alert-danger-bg` (danger soft), `--pc-radius` (8px), `--pc-radius-lg` (20px), `--pc-shadow-sm` (with a dark value) and `--pc-font-mono`.
- **Guard:** `apps/web/src/app/no-literal-colours.spec.ts` scans every `*.module.css` and fails on a hex, `rgb()`, `hsl()`, `white` or `black` outside its allow-list. It skips `@media print` and shadow properties (`box-shadow`, `text-shadow`, `filter`), which are depth, not colour roles. The allow-list holds the reports treemap and heatmap text, which sits on chart series fills, and, as TODO entries, the files the web shell and shared list PRs own (`components/app-shell/**`, `page-header`, `data-table`, filter, chip and row-menu components, `app/(app)/products/**`).
- Screenshots: `screenshots/pr-web-colour-sweep/`, 1440 × 900, light and dark, before and after.

## Desktop colour sweep

Every colour in the counter's renderer comes from a token. [`tokens.css`](../../../apps/pos-desktop/src/renderer/src/tokens.css) is the one renderer file that holds literals, and [`colour-literals.spec.ts`](../../../apps/pos-desktop/src/renderer/src/colour-literals.spec.ts) fails on a hex, `rgb()`/`hsl()`, named colour or web `--pc-*` colour anywhere else in `src/renderer/src` (stylesheets and component strings), with an allow-list that is empty today. Receipt and print HTML in `src/main/printing` is outside it.

- **Follows the accent now:** primary buttons and the PIN pad's Go (`--pos-grad` runs from `--ui-accent` to `--ui-accent-hover`, so the accent ink keeps its contrast across the fill), the focus ring (`--pos-focus`), the key hints on a primary button (tinted from `--ui-accent-ink`, one rule for light and dark), and the tile that was fixed teal: receiving on Counter work, the counter on This counter, the first avatar colour and Cash & shift's "other" method. That tile is `--pos-t-accent` (it was `--pos-t-teal`).
- **Solid ok, warn and bad fills** (Counter work's step dots, Dispensing's done tick, Setup's done steps) draw their tick in `--pos-on-status` (`--ui-on-status`) instead of the surface colour.
- **Stays the counter's own:** the other tile colours (`--pos-t-cyan`, `-indigo`, `-rose`, `-amber`, `-violet`, `-emerald`, `-blue`), prescription purple (`--pos-rx*`), shadows and the sheet scrim. The PharmaCeylon mark in the title bar keeps its teal as `--pos-logo-grad`, `--pos-logo-ink` and `--pos-logo-edge`.
- `App.module.css`, the last stylesheet on the web's `--pc-*` names, was imported nowhere and is gone.
- Screenshots: `screenshots/pr-desktop-colour-sweep/`, before and after, Sell, Counter work, Cash & shift and Returns at 1366 × 768 and 1024 × 640 in light and dark, from the screenshot fixture.

## Not done yet

These items in #205's Phase 1 come in later PRs:

- **Web shell.**
- **Inventory, Purchasing and the other list pages** moving onto the list pattern (Phase 4).
- **Colours left in the files the shell and list PRs own.** 32 literals in `app-shell.module.css`, `products.module.css` and `product-detail.module.css` (white text on accent fills, a photo overlay, and the dark sidebar's hard-coded palette). Sweep them once those PRs merge and drop their TODO entries from the guard's allow-list.

## Screenshots

`screenshots/pr1-tokens/` holds before and after captures for the token PR. Web pages are at 1440 × 900 (before and after) and 1366 × 768 (after), signed in as the seed owner. Desktop pages are at 1366 × 768 and 1024 × 640, from the screenshot fixture. Each is in light and dark. The changes are deliberately small: muted text and links get darker on light, muted text gets lighter on dark, and the default teal is one step deeper.
