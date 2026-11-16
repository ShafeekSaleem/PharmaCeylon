/**
 * Captures Counter work task states (#172 Stage 2) from the screenshot fixture, at the counter
 * window sizes, scale 1. Usage:
 *   npm run build:screenshot -w pos-desktop && npm run capture:work -w pos-desktop
 */
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const appDir = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const dist = join(appDir, "dist/renderer");
const outDir = join(appDir, "../../docs/design/desktop-app/screenshots/pr172");

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

function serve(root) {
  return createServer((req, res) => {
    const path = join(
      root,
      (req.url ?? "/").split("?")[0] || "/screenshot.html",
    );
    const file =
      path.startsWith(root) && existsSync(path)
        ? path
        : join(root, "screenshot.html");
    res.writeHead(200, {
      "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
    });
    createReadStream(file).pipe(res);
  });
}

/** What each state must show before it is captured. */
const states = [
  { state: "ready", expect: /Next: Book in held delivery/ },
  { state: "stale", expect: /Changed since approval/ },
  { state: "offline", expect: /showing the list from/ },
];
const sizes = [
  { width: 1366, height: 768, tag: "1366x768" },
  { width: 1024, height: 640, tag: "1024x640" },
];

if (!existsSync(join(dist, "screenshot.html"))) {
  console.error(
    "Missing dist/renderer/screenshot.html — run npm run build:screenshot -w pos-desktop first",
  );
  process.exit(1);
}
await mkdir(outDir, { recursive: true });

const server = serve(dist);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const browser = await chromium.launch();

for (const { state, expect } of states) {
  for (const { width, height, tag } of sizes) {
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: 1,
      });
      const page = await context.newPage();
      await page.goto(
        `http://127.0.0.1:${port}/screenshot.html?theme=${theme}&page=work&state=${state}`,
        {
          waitUntil: "networkidle",
        },
      );
      await page.waitForSelector(`[data-screenshot-work="${state}"]`);
      await page.getByText(expect).first().waitFor();
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      if (overflow > 0)
        console.warn(
          `${state} ${tag} ${theme}: horizontal overflow ${overflow}px`,
        );
      const name = `p2b-pr172-work-${state}-${tag}-${theme}.png`;
      await page.screenshot({
        path: join(outDir, name),
        clip: { x: 0, y: 0, width, height },
        scale: "css",
      });
      console.log(name);
      await context.close();
    }
  }
}

await browser.close();
server.close();
