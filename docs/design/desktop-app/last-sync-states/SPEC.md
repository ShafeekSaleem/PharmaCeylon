# Desktop POS: title bar and status bar last-sync states

P2b shell · epic #103 · PR 138 (head `a510d07`, base `develop` `ebf6e43`) · design review, 11 Nov 2026
Review page: `index.html` (`?theme=light|dark|both`, `&ctx=<id>` opens one state in the full shell)
Example times are for Wed 11 Nov 2026, 14:44:10 (Asia/Colombo).

> **Approved 11 Nov 2026 (Shafeek, via Emma): colours + 15 min overdue.** States 0–6 below are approved exactly as shown, overdue threshold = **15 min**. They are unchanged. The *Two-way sync* section at the end is a follow-up proposal, built on top of them.

## What stays the same
- The pill, dot, sizes, status-bar segment and approved baseline (state 0) come straight from `Shell.module.css` / `Shell.tsx` in PR 138.
- Existing tones: `.conn` (ok), `.connWait`, `.connBad`, `.sbOk`, `.sbBad`.
- **New:** `.connInfo` / `.sbInfo` and `.connWarn` / `.sbWarn`, plus `.sbWait`. These use the same shape, built on `--pos-info-*` and `--pos-warn-*` tokens that already exist in `tokens.css`. No new tokens.
- Times use the app's own 24-hour `time()` and `timeWithSeconds()` (en-GB, h23), so "14:32:08", not "2:32 PM". The relative age uses PR 138's `formatSyncedAgo` (s / min / h / days).

## States (counter enrolled, `enrollment.status === "active"`)
| # | State | Trigger | Title bar pill | Status bar lead | Tone (light / dark dot) | Tooltip (pill + status) | Data on PR 138 |
|---|---|---|---|---|---|---|---|
| 0 | Synced (baseline) | reachable · !syncing · lastSuccessAt within threshold | **Online** · synced 8 s ago | **Online** · last sync 14:44:02 | ok `--pos-ok` #16a34a / #34d399 | Last sync: Wednesday, 11 November 2026, 14:44:02 · Server checked 14:44:05 | ✅ shipped |
| 1 | Checking the server | `api === null` (first check after app start) | **Checking the server…** | **Checking the server…** · last sync 14:32:08 *(omit the suffix if lastSuccessAt is null)* | wait `--pos-text-3` #8391a7 / #6b7a93 (existing `.connWait`), dot pulses | Last sync: … 14:32:08 · No server answer yet | ✅ api null + lastSuccessAt |
| 2 | Online, syncing | reachable · `journal.syncing` | **Online** · syncing… | **Online** · syncing now · last sync 14:39:51 *(suffix only if known)* | info `--pos-info` #0891b2 / #22d3ee, dot pulses | Sending this counter's records to the server · Last sync: … | ✅ `journal.syncing` |
| 3 | Online, never synced | reachable · !syncing · lastSuccessAt null | **Online** · not synced yet | **Online** · not synced yet | warn `--pos-warn` #d97706 / #fbbf24 | This counter hasn't finished a sync with the server yet · Server checked … | ✅ |
| 4 | Offline, never synced | !reachable · lastSuccessAt null | **Offline** · not synced yet | **Offline** · not synced yet | bad `--pos-bad` #dc2626 / #f87171 (existing `.connBad`) | Can't reach the server. This counter hasn't synced yet · Server checked … | ✅ |
| 5 | Offline, last sync known | !reachable · lastSuccessAt set | **Offline** · last synced 12 min ago | **Offline** · last sync 14:32:08 | bad | Can't reach the server · Last sync: Wednesday, 11 November 2026, 14:32:08 · Server checked … | ✅ |
| 5b | ⤷ last sync on an earlier day | as 5, not today (Asia/Colombo) | **Offline** · last synced 2 days ago | **Offline** · last sync Mon 9 Nov 18:05 | bad | … Monday, 9 November 2026, 18:05:41 … | ✅ (`shortDay` + `time`) |
| 6 | Sync overdue *(optional)* | reachable · !syncing · now − lastSuccessAt > **threshold (open, proposed 15 min)** | **Online** · sync overdue · 2 h ago | **Online** · sync overdue · last sync 12:41:30 | warn | Last sync: … 12:41:30 · `journal.issue.message` if any · Server checked … | ✅ data; threshold is a new constant |

Rule for the earlier-day status-bar form: when lastSuccessAt is not today, show `shortDay · time` without seconds (as in 5b). This applies to every state that shows the status-bar time.

Out of scope here, so the existing behaviour stays: setup (`Server reachable`, no status bar), the lock screen (no status bar), and revoked counters (reachability pill + "· switched off").

## Data vs develop / PR 138
- Everything above comes from data the renderer already has: `ApiReachability {reachable, checkedAt}` (polled every 15 s, `null` only until the first answer) and `JournalSync {syncing, lastSuccessAt, issue}` (read locally every 3 s, also while offline). No API change.
- **What "last sync" means:** `lastSuccessAt` is the time the server last confirmed this counter's whole offline journal (an upload confirm). Fresh stock and other data coming down are not tracked as a timestamp. If Shafeek wants "synced" to cover both directions, that needs a new local field. **Not designed here, and no contract invented.**
- **Overdue** needs no new data, only a threshold constant. P5 sends an empty confirm every 5 min (`JOURNAL_CONFIRM_MS`) and ticks every 15 s, so a healthy counter is never more than about 5 min old.
- `api.checkedAt` appears in tooltips only, as "Server checked …". It is never used as the sync time (per LAST_SYNC_BAR rule 5).

## Transitions and precedence
1. Not active → existing behaviour (setup / revoked).
2. `api === null` → **1 Checking**. This happens only before the first answer. Later polls keep the previous value, so there's no flicker back to "Checking" every 15 s.
3. `!reachable` → **5** if lastSuccessAt is set, otherwise **4**. `syncing` is ignored while offline.
4. `reachable && syncing` → **2**.
5. `reachable && !lastSuccessAt` → **3**.
6. `reachable && age > threshold` → **6** (if adopted), otherwise **0**.
- Checking ends on the first reachability answer and goes to online (2/3/6/0) or offline (4/5).
- Anti-flicker (proposed): show **2 Syncing** only if a cycle runs longer than about 1 s, and keep it on screen for at least 1 s. The usual 5-min empty confirm finishes fast, so 0 should stay steady.
- Overdue clears as soon as a sync succeeds (6 → 0). Offline → online re-enters through 2 when the reconnect drain runs (P5 `SyncBlock` still covers Sell; unchanged).

## Accessibility
- Never colour alone: every state starts with a word (Online / Offline / Checking) and has its own detail text. The tone only backs it up.
- The pill keeps `role="status"` (polite). **Announce state changes only:** put the ticking relative age in `aria-hidden`, or announce a fixed label such as "Offline, last sync 14:32", so screen readers don't read "8 s ago, 9 s ago…" every second.
- The status-bar lead segment repeats the pill, so it should not be a live region (no double announcements).
- Pulsing dot (states 1 and 2): opacity 1 → .35 over 1.2 s, turned off under `prefers-reduced-motion`.
- Tooltips use `title` (or the app tooltip) on both the pill and the status segment. The full date carries the same information in text.
- Contrast: ink-on-soft pairs are the existing `--pos-*-ink` / `--pos-*-soft` pairs already used by `.connBad` and the mockup's ok pill, in both themes.

## Decisions (resolved 11 Nov 2026)
- 1 → 15 min approved. 2 → colours approved. 3 → "synced" covers BOTH directions, see Two-way sync.

Original questions:
1. **Overdue threshold:** proposed **15 min** (three missed 5-min confirms). Alternatives: 10 min or 30 min, or drop state 6.
2. **Tones:** offline stays **red** to match the current approved pill and the "server can't be reached" block. Never-synced-online and overdue are **amber**, syncing is **cyan**. Is amber/cyan OK on the pill?
3. **Meaning of "synced":** upload confirmed (data available now), or also the latest stock download (needs a new field)?

## Two-way sync — Approved 11 Nov 2026
> **Approved 11 Nov 2026, 14:55 Asia/Colombo (Shafeek, via Emma).** This section is the build source for Oliver, together with states 0–6 above.
> - **D1:** counters that aren't the branch's offline counter show **sales sync only**. Stock never affects their pill, status bar or tooltip (T7).
> - **D2:** the old T4 "N sales to send" state is **dropped**. Sales waiting fold into the approved **"syncing…"** state (state 2, cyan). The status bar and tooltip may show how many sales are waiting. There is no separate state. The cases below are renumbered T1–T7.

Review: `index.html#two-way` (or `index.html?section=twoway&theme=light|dark`), PNGs `two-way-light.png` / `two-way-dark.png`.

**"Synced" = both directions:** sales sent (the server confirmed the journal upload, `JournalSync.lastSuccessAt`) **and** stock updated (the latest signed stock snapshot installed, proposed `lastStockDownloadAt`). On a counter that isn't the offline counter, "synced" = sales sent only.

**How each direction is judged (threshold 15 min, approved):**
- **Fresh:** 15 min old or less.
- **Overdue:** more than 15 min old. For sales, this also covers entries waiting longer than 15 min.
- **Never:** no time recorded (null).

**Rules (order of precedence)**
1. **Not active:** existing behaviour (setup / revoked).
2. **`api === null`:** state 1 "Checking the server…".
3. **Offline:** stays red with the approved copy (states 4/5). The age is the older of the times shown. No amber per direction (the red Offline already says it). The status bar still lists both times, muted (T6).
4. **Syncing (state 2, cyan, "Online · syncing…"):** shown when `journal.syncing`, or when `journal.waiting > 0` and the sales direction is not overdue.
   - Status bar: `Online · ↑ Syncing N sales · Stock updated HH:MM`. When the waiting count is 0, it is `Online · ↑ Syncing · Stock updated HH:MM`.
   - Tooltip first line: `Syncing · N sales waiting to send`.
5. **Otherwise the pill shows the worst direction.** If one direction is overdue or never, the pill names it ("stock overdue · 32 min ago", "stock not updated yet", "sales overdue · 2 h ago"), amber. If both are bad, it uses the approved generic copy (state 6 "sync overdue · …", or state 3 "not synced yet"), amber. If both are fresh, it shows "synced X ago" from the **older** time, green.
- **Status bar:** shows both directions: `Sales sent HH:MM · Stock updated HH:MM` (no seconds, so two times fit). A bad direction gets amber ink + ⚠ icon + the word "overdue" or "not updated yet". Never colour alone.
- **Tooltip:** one line per direction with the full Asia/Colombo date and seconds, plus `journal.issue.message` when present, plus `Server checked HH:MM:SS · Sri Lanka time`.
- **Not the offline counter (`nominated === false`):** drop every stock part. The pill and tooltip follow sales only, and the status bar shows `Online · Sales sent HH:MM`. Overdue, never and offline use the approved single-direction copy (states 3–6). While `nominated` is still unknown (null, before the first answer), treat the counter as sales-only so the pill doesn't flash amber for stock.

| # | Case | Pill | Status bar lead | Tone |
|---|---|---|---|---|
| T1 | Both fresh | Online · synced 4 min ago | Online · Sales sent 14:44 · Stock updated 14:40 | ok |
| T2 | Sales fresh, stock > 15 min | Online · stock overdue · 32 min ago | Online · Sales sent 14:44 · ⚠ Stock updated 14:12, overdue | warn |
| T3 | Sales fresh, stock never | Online · stock not updated yet | Online · Sales sent 14:44 · ⚠ Stock not updated yet | warn |
| (2) | Syncing / sales waiting (approved state 2; not a new state) | Online · syncing… | Online · ↑ Syncing 3 sales · Stock updated 14:40 | info |
| T4 | Stock fresh, sales overdue | Online · sales overdue · 2 h ago | Online · ⚠ Sales sent 12:41, overdue · Stock updated 14:40 | warn |
| T5 | Both overdue | Online · sync overdue · 2 h ago (approved) | Online · ⚠ Sales sent 12:41, overdue · ⚠ Stock updated 12:38, overdue | warn |
| T6 | Offline, both known | Offline · last synced 24 min ago | Offline · Sales sent 14:32 · Stock updated 14:20 | bad |
| T7 | Not the offline counter (sales only) | Online · synced 8 s ago | Online · Sales sent 14:44 | ok |

Example tooltips:
- **T2:** `Sales sent: Wednesday, 11 November 2026, 14:44:02` / `Stock updated: Wednesday, 11 November 2026, 14:12:18 · overdue (over 15 min)` / `Server checked: 14:44:05 · Sri Lanka time`
- **T7:** `Sales sent: Wednesday, 11 November 2026, 14:44:02` / `Server checked: 14:44:05 · Sri Lanka time`

### Data the renderer needs (proposal for John and Oliver; not a contract change)
What "stock download" is on PR 138 / develop: the **offline-authority pair**. `offline-authority-refresh.ts` calls `POST /api/v1/terminals/offline-authority` every 5 min (`OFFLINE_AUTHORITY_REFRESH_MS`) and installs a signed `BranchStockSnapshot` into the `offline_authority` table (`snapshot_envelope`). There is no separate pull cursor. The other stock reads (`stock-lookup.ts`) are live per-search requests, not a download.

1. **`lastStockDownloadAt: string | null`** (ISO) in `JournalSync`, the object the renderer already polls every 3 s via `getJournalSync`, next to `lastSuccessAt` and `lastDrainAt`. Main fills it in `journalSyncState()`.
   - **Recommended source:** `readInstalledOfflineAuthority(db, enrollmentId).snapshot.payload.generatedAt`. It is server-signed and saved on disk, so it survives a restart and a store restore. It is the same value the readiness check compares against `MAX_SNAPSHOT_AGE_AT_OUTAGE_MS` (15 min, matching the approved threshold).
   - **Alternative:** `OfflineAuthorityRefreshStatus.lastSuccessAt` (the response time). It is in memory only and resets to null on restart, so the pill would wrongly say "stock not updated yet" after every launch. Not recommended as the only source.
   - **Already exposed:** `ReadinessReport.offlineBackup.snapshotGeneratedAt` carries the same value, but readiness isn't polled, so it can't drive a live pill.
   - **Name alternatives that fit the shape:** `stockUpdatedAt` or `lastSnapshotAt`. Whatever the name, it stays a plain ISO string.
2. **A flag saying whether this counter is the branch's offline counter (needed for D1).** Today it lives only in `OfflineAuthorityRefreshStatus.nominated` (`boolean | null`, in memory; the server answers "not nominated" and the counter rechecks every 15 min). It needs to reach the renderer, e.g. as `stockDownloadNominated: boolean | null` next to `lastStockDownloadAt`. The name is up to John and Oliver.
- **Coupling to know about:** stock renewal is skipped while journal entries wait (`journalWaiting`). So a long sales backlog also ages the stock, and T4 usually turns into T5 after 15 min. That is expected, not a bug.

### Open decisions
None. D1 and D2 are approved (11 Nov 2026, 14:55 Asia/Colombo).

## Files
`index.html` (self-contained), `two-way-light.png`, `two-way-dark.png`, `overview-light.png`, `overview-dark.png`, `overview-both.png`, `context-{1,5}-{light,dark}.png`, `build.py` (generates index.html), `shoot.cjs` (renders PNGs with playwright-core + system Chrome).
