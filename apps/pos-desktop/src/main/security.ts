import { app, net, protocol, type Session } from "electron";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { APP_SCHEME, isAppUrl, resolveRendererFile } from "./renderer-path";

/**
 * The renderer loads nothing but its own bundled files and talks to nothing
 * but the preload bridge — every network call is made by the main process.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** Vite's dev server needs inline scripts/styles and a websocket for HMR. Never used in a packaged build. */
const DEV_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self' ws:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/** Must run before the app is ready. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true } }]);
}

/** Serves the built renderer from pos://app with the production CSP on every response. */
export function serveRenderer(rendererDir: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const file = resolveRendererFile(rendererDir, request.url);
    const mimeType = file ? MIME_TYPES[extname(file).toLowerCase()] : undefined;
    if (!file || !mimeType) return new Response(null, { status: 404 });
    try {
      return new Response(await readFile(file), {
        headers: {
          "Content-Type": mimeType,
          "Content-Security-Policy": CONTENT_SECURITY_POLICY,
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}

export function hardenSession(session: Session, devServerOrigin: string | null): void {
  // Camera, microphone, geolocation, notifications…: a till needs none of them.
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);

  if (devServerOrigin) {
    session.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [DEV_CONTENT_SECURITY_POLICY] },
      });
    });
  }
}

export function hardenWebContents(devServerOrigin: string | null): void {
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-attach-webview", (event) => event.preventDefault());

    const blockForeignNavigation = (event: Electron.Event, url: string) => {
      if (!isAppUrl(url, devServerOrigin)) event.preventDefault();
    };
    contents.on("will-navigate", blockForeignNavigation);
    contents.on("will-redirect", blockForeignNavigation);

    // webPreferences.devTools is already off in a packaged build; this covers
    // any other route to opening them.
    if (app.isPackaged) contents.on("devtools-opened", () => contents.closeDevTools());
  });
}

/** Main-process HTTP, kept behind one function so the renderer never needs network access. */
export const mainFetch = (url: string, init: { signal: AbortSignal }) => net.fetch(url, init);
