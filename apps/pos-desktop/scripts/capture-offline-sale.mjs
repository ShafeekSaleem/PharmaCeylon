/**
 * Captures the offline counter (P4 #50, 4b) from the screenshot fixture: the real renderer over
 * a fixture `window.pos`, driven by clicks. 1366×768, scale 1, light and dark. Usage:
 *   rm -rf dist/renderer && POS_SCREENSHOT_BUILD=1 npx electron-vite build
 *   node scripts/capture-offline-sale.mjs
 */
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const appDir = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const dist = join(appDir, "dist/renderer");
const outDir = join(appDir, "../../docs/design/desktop-app/screenshots/p4-4b");

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
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  });
}

if (!existsSync(join(dist, "screenshot.html"))) {
  console.error("Missing dist/renderer/screenshot.html — build the screenshot renderer first");
  process.exit(1);
}
await mkdir(outDir, { recursive: true });

const server = serve(dist);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const browser = await chromium.launch();
const width = 1366;
const height = 768;

async function open(theme, query = "") {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/screenshot.html?theme=${theme}&page=offline${query}`, {
    waitUntil: "networkidle",
  });
  await page.waitForSelector("[data-screenshot-offline]");
  return { context, page };
}

async function shot(page, name, theme) {
  await page.waitForTimeout(150);
  const file = `p4-4b-${name}-${theme}.png`;
  await page.screenshot({ path: join(outDir, file), clip: { x: 0, y: 0, width, height }, scale: "css" });
  console.log(file);
}

async function add(page, query, name) {
  await page.getByLabel("Search offline stock").fill(query);
  await page.getByText(name, { exact: true }).first().click();
}

async function approve(page, reference, code) {
  await page.getByRole("button", { name: "Approved" }).click();
  await page.getByLabel("Slip reference").fill(reference);
  await page.getByLabel("Approval code").fill(code);
  await page.getByLabel("Time on the slip").fill("15:52");
  await page.getByRole("button", { name: "Record approval" }).click();
  await page.getByText(/Card approved/).waitFor();
}

for (const theme of ["light", "dark"]) {
  // Sell: search, cart, card, receipt.
  {
    const { context, page } = await open(theme);
    await page.getByText("Selling from last-known stock").waitFor();
    await page.getByLabel("Search offline stock").fill("pana");
    await page.getByText("Stock under review").waitFor();
    await shot(page, "d-enter", theme);

    await page.getByText("Panadol 500mg Tablets", { exact: true }).first().click();
    await add(page, "ors", "Jeevanee ORS Sachet");
    await page.getByLabel("Cash received").fill("500");
    await shot(page, "d-cart", theme);

    await page.getByRole("button", { name: "Card", exact: true }).click();
    await page.getByRole("button", { name: /Charge Rs .* on the card machine/ }).click();
    await page.getByText(/Charge Rs .* on the card machine now/).waitFor();
    await shot(page, "card-prepared", theme);
    await approve(page, "RRN 004471", "A1B2C3");
    await shot(page, "card-approved", theme);

    await page.getByRole("button", { name: /Complete sale/ }).click();
    await page.getByRole("dialog", { name: /Receipt C1R-000186/ }).waitFor();
    await shot(page, "d-done", theme);
    await context.close();
  }
  // Split: part on the card, the rest in cash.
  {
    const { context, page } = await open(theme);
    await add(page, "vitamin", "Vitamin C 500mg Chewable");
    await add(page, "samahan", "Link Samahan Herbal Drink");
    await page.getByRole("button", { name: "Split", exact: true }).click();
    await page.getByLabel("On the card").fill("150");
    await page.getByRole("button", { name: /Charge Rs 150.00 on the card machine/ }).click();
    await approve(page, "RRN 004472", "D4E5F6");
    await page.getByLabel(/Cash for the rest/).fill("100");
    await shot(page, "split", theme);
    await context.close();
  }
  // After hours (D8): the banner, then the manager's sheet.
  {
    const { context, page } = await open(theme, "&hours=needs");
    await page.getByText("It's outside selling hours").waitFor();
    await shot(page, "hours-banner", theme);
    await page.getByRole("button", { name: "Manager acknowledges…" }).click();
    await page.getByRole("button", { name: "2 h" }).click();
    await page.getByLabel("Reason").fill("Queue at closing time");
    await page.getByLabel("Manager's PIN").fill("2468");
    await shot(page, "hours-sheet", theme);
    await page.getByRole("button", { name: "Acknowledge", exact: true }).click();
    await page.getByText("Selling after hours").waitFor();
    await shot(page, "hours-acknowledged", theme);
    await context.close();
  }
  // Closing your own shift.
  {
    const { context, page } = await open(theme);
    await page.getByRole("button", { name: "Cash & shift" }).click();
    await page.getByText("Close your shift").waitFor();
    await page.getByLabel("Number of 5,000 notes").fill("4");
    await page.getByLabel("Number of 1,000 notes").fill("4");
    await page.getByLabel("Coins, in rupees").fill("650");
    await page.getByLabel("What happened (optional)").fill("Gave too much change at 14:10");
    await shot(page, "close-own", theme);
    await page.getByRole("button", { name: "Switch person" }).first().click();
    await page.getByText("Who's at the counter?").waitFor();
    await shot(page, "switch-person", theme);
    await context.close();
  }
  // A manager closing someone else's shift.
  {
    const { context, page } = await open(theme, "&till=other");
    await page.getByText("Sachini Rathnayake's shift is open on this till").waitFor();
    await shot(page, "handover-gate", theme);
    await page.getByRole("button", { name: /Close it for them/ }).click();
    await page.getByLabel("Number of 5,000 notes").fill("2");
    await page.getByLabel("Number of 1,000 notes").fill("2");
    await page.getByLabel("Coins, in rupees").fill("624");
    await page.getByLabel("Why you're closing it for them").fill("Sachini went home unwell");
    await page.getByLabel("Your PIN, Dilini").fill("2468");
    await shot(page, "handover-close", theme);
    await context.close();
  }
}

await browser.close();
server.close();
