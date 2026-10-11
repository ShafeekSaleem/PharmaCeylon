import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { APP_ORIGIN } from "./renderer-path";

export function createMainWindow(opts: { devServerUrl: string | null; show: boolean }): BrowserWindow {
  const window = new BrowserWindow({
    // The spec's baseline counter display is 1366×768.
    width: 1366,
    height: 768,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: "Curalio POS",
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

  if (opts.show) window.once("ready-to-show", () => window.show());
  void window.loadURL(opts.devServerUrl ?? `${APP_ORIGIN}/`);
  return window;
}
