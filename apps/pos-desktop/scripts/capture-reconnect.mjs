/**
 * P4 #50, slice 4c: captures the real App on fixture answers after reconnecting (d-queue, d-drain,
 * d-review, d-stock, d-clean), light and dark, at the mockups' 1600×1000.
 * Usage (bash, not cmd): npm run build:screenshot -w pos-desktop && node apps/pos-desktop/scripts/capture-reconnect.mjs
 */
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const appDir = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const dist = join(appDir, "dist/renderer");
const outDir = join(
  appDir,
  "../../docs/design/desktop-app/screenshots/p4-reconnect",
);

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

if (!existsSync(join(dist, "screenshot.html"))) {
  console.error(
    "Missing dist/renderer/screenshot.html — run npm run build:screenshot -w pos-desktop first",
  );
  process.exit(1);
}
await mkdir(outDir, { recursive: true });

/** Each shot, and what shows it is ready; the queue opens from the title bar's count. */
const shots = [
  { id: "queue", chip: /to send/ },
  { id: "drain", chip: /to send/ },
  { id: "review", chip: /need review/ },
  { id: "stock", text: /Stock under review/ },
  { id: "clean", text: /is unchanged/ },
];

const server = serve(dist);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const browser = await chromium.launch();

for (const shot of shots) {
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    page.on("pageerror", (error) =>
      console.error(`${shot.id} ${theme}:`, error.message),
    );
    await page.goto(
      `http://127.0.0.1:${port}/screenshot.html?reconnect=${shot.id}&theme=${theme}`,
      {
        waitUntil: "networkidle",
      },
    );
    if (shot.chip) {
      const chip = page.getByRole("button", { name: shot.chip });
      await chip.waitFor();
      await chip.click();
      await page.getByRole("dialog").waitFor();
    } else {
      await page.getByText(shot.text).first().waitFor();
    }
    await page.waitForTimeout(300);
    const file = join(outDir, `d-${shot.id}-${theme}.png`);
    await page.screenshot({ path: file });
    console.log("wrote", file);
    await context.close();
  }
}

await browser.close();
server.close();
