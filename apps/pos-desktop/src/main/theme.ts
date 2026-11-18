import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  counterThemeSchema,
  type CounterTheme,
  type CounterThemeView,
} from "../shared/ipc-contract";

/**
 * The counter app's light/dark choice (Epic UI1 #205).
 *
 * It is applied through Electron's `nativeTheme.themeSource`, which does two things at once: the
 * page's `prefers-color-scheme` follows it (so tokens.css switches with no `data-theme` in the
 * renderer), and `nativeTheme` fires "updated", which window.ts already uses to repaint the Windows
 * minimise, maximise and close buttons. So the title bar and the page can never disagree.
 *
 * Who decides: the owner sets a default for every counter in the pharmacy brand, and may lock it.
 * Unlocked, a cashier's switch on this computer wins over the default; locked, the default wins and
 * the switch is hidden. The cashier's last choice is kept through a lock, so unlocking brings it
 * back. "system" follows Windows.
 */
export type ThemeTarget = { themeSource: CounterTheme };

/** The owner's side, from the cached pharmacy brand. */
export type CounterThemePolicy = { theme: CounterTheme; locked: boolean };

const FOLLOW_WINDOWS: CounterThemePolicy = { theme: "system", locked: false };

/** The cashier's saved choice on this computer, or null when there is none. */
export function readCounterTheme(path: string): CounterTheme | null {
  try {
    const parsed = counterThemeSchema.safeParse(
      (JSON.parse(readFileSync(path, "utf8")) as { theme?: unknown }).theme,
    );
    return parsed.success ? parsed.data : null;
  } catch {
    // Missing or unreadable file: no choice made here.
    return null;
  }
}

export function writeCounterTheme(path: string, theme: CounterTheme): void {
  mkdirSync(dirname(path), { recursive: true });
  // Write then rename, so a power cut mid-write leaves the old choice rather than a broken file.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ theme }));
  renameSync(tmp, path);
}

/** What the counter should show for a policy and the cashier's own choice. */
export function effectiveCounterTheme(
  policy: CounterThemePolicy,
  saved: CounterTheme | null,
): CounterTheme {
  return policy.locked ? policy.theme : (saved ?? policy.theme);
}

export function createCounterTheme(
  path: string,
  target: ThemeTarget,
  policy: () => CounterThemePolicy = () => FOLLOW_WINDOWS,
) {
  const view = (): CounterThemeView => {
    const p = policy();
    return {
      theme: effectiveCounterTheme(p, readCounterTheme(path)),
      locked: p.locked,
    };
  };
  return {
    /** Applies the current answer; call before the window is created so the first paint is
     *  right, and again whenever the brand changes. */
    apply(): CounterThemeView {
      const current = view();
      if (target.themeSource !== current.theme)
        target.themeSource = current.theme;
      return current;
    },
    get: view,
    /** The cashier's switch. Refused while the owner has locked the theme. */
    set(theme: CounterTheme): CounterThemeView {
      if (policy().locked) return view();
      writeCounterTheme(path, theme);
      target.themeSource = theme;
      return view();
    },
  };
}
