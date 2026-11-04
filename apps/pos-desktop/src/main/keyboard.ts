/**
 * Keys Chromium or Electron would act on before the counter's own key map (renderer keymap.ts)
 * sees them.
 *
 * The counter's keys (F6–F10, F12, Esc, Ctrl+Enter, digits) are all handled in the renderer, which
 * prevents their defaults there, so Windows never puts the window into menu mode on F10. Nothing
 * here may block one of them: `before-input-event`'s preventDefault would stop the renderer from
 * seeing the key at all.
 *
 * What is blocked, in a packaged build only, is a page reload and the developer tools: a reload
 * drops the sale on screen. A packaged build has no application menu (so no accelerators) and
 * webPreferences.devTools is off already, so this is the backstop for any default Chromium or a
 * future Electron adds. Development builds keep Electron's default menu: Ctrl+R reloads,
 * Ctrl+Shift+I opens the developer tools, F11 is full screen. None of those is a counter key.
 */
export type KeyInput = {
  type: string;
  key: string;
  control: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
};

/** Keys that belong to the counter's key map; never blocked here. */
export const COUNTER_KEYS = new Set(["F6", "F7", "F8", "F9", "F10", "F12", "Escape", "Enter"]);

export function blockedInPackagedBuild(input: KeyInput): boolean {
  if (input.type !== "keyDown" || COUNTER_KEYS.has(input.key)) return false;
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
  const ctrl = input.control || input.meta;
  if (key === "F5" || key === "BrowserRefresh") return true;
  if (ctrl && key === "r") return true;
  if (ctrl && input.shift && (key === "i" || key === "j" || key === "c")) return true;
  return false;
}
