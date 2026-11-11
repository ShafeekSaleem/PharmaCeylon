/**
 * Captures the built screenshot fixture at exact counter window sizes (scale 1).
 * Usage: npm run build:screenshot -w pos-desktop && npm run capture:shell -w pos-desktop
 */
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const appDir = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const dist = join(appDir, "dist/renderer");
const repoRoot = join(appDir, "../..");
const docDir = join(repoRoot, "docs/design/desktop-app/screenshots/pr170");
const outDir = docDir;

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
    const path = join(root, (req.url ?? "/").split("?")[0] || "/screenshot.html");
    const file = path.startsWith(root) && existsSync(path) ? path : join(root, "screenshot.html");
    const type = MIME[extname(file)] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    createReadStream(file).pipe(res);
  });
}

const sizes = [
  { width: 1366, height: 768, tag: "1366x768" },
  { width: 1024, height: 640, tag: "1024x640" },
];

await mkdir(docDir, { recursive: true });

if (!existsSync(join(dist, "screenshot.html"))) {
  console.error("Missing dist/renderer/screenshot.html — run npm run build:screenshot -w pos-desktop first");
  process.exit(1);
}

const server = serve(dist);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const browser = await chromium.launch();

for (const { width, height, tag } of sizes) {
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/screenshot.html?theme=${theme}`, {
      waitUntil: "networkidle",
    });
    await page.waitForSelector("[data-screenshot-shell]");
    await page.getByText(/Offline backup · ready until/).waitFor();

    const leadWord = page.locator("footer b").filter({ hasText: /^Online$/ }).first();
    await leadWord.waitFor();
    const leadBox = await leadWord.boundingBox();
    const leadText = (await leadWord.textContent())?.trim();
    if (leadText !== "Online" || !leadBox || leadBox.width < 28) {
      throw new Error(
        `${tag} ${theme}: lead status word must stay full "Online" (got "${leadText}", width ${leadBox?.width})`,
      );
    }

    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      body: document.body.scrollWidth - document.body.clientWidth,
    }));
  if (overflow.doc > 0 || overflow.body > 0) {
      console.warn(`${tag} ${theme}: horizontal overflow doc=${overflow.doc} body=${overflow.body}`);
    }

    const name = `p2b-pr170-app-sell-${tag}-${theme}.png`;
    await page.screenshot({
      path: join(outDir, name),
      clip: { x: 0, y: 0, width, height },
      scale: "css",
    });
    console.log(join(outDir, name));
    await context.close();
  }
}

await browser.close();
server.close();
