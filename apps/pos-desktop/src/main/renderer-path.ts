import { resolve, sep } from "node:path";

export const APP_SCHEME = "pos";
export const APP_HOST = "app";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/**
 * Maps a pos://app/... request onto a file inside the built renderer
 * directory, or null if the request points anywhere else.
 */
export function resolveRendererFile(rendererDir: string, requestUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return null;

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (pathname.includes("\0")) return null;

  const root = resolve(rendererDir);
  const file = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
  return file.startsWith(root + sep) ? file : null;
}

export function isAppUrl(url: string, devServerOrigin: string | null): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === `${APP_SCHEME}:`) return parsed.host === APP_HOST;
    return devServerOrigin !== null && parsed.origin === devServerOrigin;
  } catch {
    return false;
  }
}
