import { app, BrowserWindow, nativeTheme } from "electron";
import { join } from "node:path";
import { APP_ORIGIN } from "./renderer-path";

/** The renderer draws the title bar (40px, the mockups' height); Windows draws its buttons over it. */
export const TITLE_BAR_HEIGHT = 40;

/** Chrome and canvas colours from docs/design/desktop-app, matching the renderer's tokens.css. */
function themeColours() {
  return nativeTheme.shouldUseDarkColors
    ? { chrome: "#0d1524", symbols: "#a3b1c6", canvas: "#0a101b" }
    : { chrome: "#ffffff", symbols: "#475569", canvas: "#f2f5f9" };
}

export function createMainWindow(opts: {
  devServerUrl: string | null;
  show: boolean;
}): BrowserWindow {
  const colours = themeColours();
  const window = new BrowserWindow({
    // The spec's baseline counter display is 1366×768.
    width: 1366,
    height: 768,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: "PharmaCeylon POS",
    backgroundColor: colours.canvas,
    // Windows keeps its own minimise, maximise and close buttons (and snapping) over our title bar.
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: colours.chrome,
      symbolColor: colours.symbols,
      height: TITLE_BAR_HEIGHT,
    },
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  // The renderer follows the Windows light/dark setting through prefers-color-scheme; the buttons follow it here.
  const followTheme = () => {
    if (window.isDestroyed()) return;
    const next = themeColours();
    window.setTitleBarOverlay({
      color: next.chrome,
      symbolColor: next.symbols,
      height: TITLE_BAR_HEIGHT,
    });
    window.setBackgroundColor(next.canvas);
  };
  nativeTheme.on("updated", followTheme);
  window.once("closed", () => nativeTheme.off("updated", followTheme));

  if (opts.show) window.once("ready-to-show", () => window.show());
  void window.loadURL(opts.devServerUrl ?? `${APP_ORIGIN}/`);
  return window;
}
