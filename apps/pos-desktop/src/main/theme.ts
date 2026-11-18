import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { counterThemeSchema, type CounterTheme } from "../shared/ipc-contract";

/**
 * The counter app's light/dark choice, remembered on this computer (Epic UI1 #205).
 *
 * It is applied through Electron's `nativeTheme.themeSource`, which does two things at once: the
 * page's `prefers-color-scheme` follows it (so tokens.css switches with no `data-theme` in the
 * renderer), and `nativeTheme` fires "updated", which window.ts already uses to repaint the Windows
 * minimise, maximise and close buttons. So the title bar and the page can never disagree.
 *
 * "system" follows Windows. Until the pharmacy brand settings land, it is also the default; the
 * back-office default and lock come with them.
 */
export type ThemeTarget = { themeSource: CounterTheme };

export function readCounterTheme(path: string): CounterTheme {
  try {
    const parsed = counterThemeSchema.safeParse(
      (JSON.parse(readFileSync(path, "utf8")) as { theme?: unknown }).theme,
    );
    return parsed.success ? parsed.data : "system";
  } catch {
    // Missing or unreadable file: follow Windows, as before this setting existed.
    return "system";
  }
}

export function writeCounterTheme(path: string, theme: CounterTheme): void {
  mkdirSync(dirname(path), { recursive: true });
  // Write then rename, so a power cut mid-write leaves the old choice rather than a broken file.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ theme }));
  renameSync(tmp, path);
}

export function createCounterTheme(path: string, target: ThemeTarget) {
  return {
    /** Applies the saved choice; call before the window is created so the first paint is right. */
    apply(): CounterTheme {
      const theme = readCounterTheme(path);
      target.themeSource = theme;
      return theme;
    },
    get(): CounterTheme {
      return readCounterTheme(path);
    },
    set(theme: CounterTheme): CounterTheme {
      writeCounterTheme(path, theme);
      target.themeSource = theme;
      return theme;
    },
  };
}
