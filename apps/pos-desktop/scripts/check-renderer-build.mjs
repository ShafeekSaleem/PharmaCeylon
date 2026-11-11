/**
 * Ensures the packaged renderer only contains production entries (index), unless
 * POS_SCREENSHOT_BUILD=1 built the optional screenshot fixture.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const dist = join(appDir, "dist/renderer");
const screenshot = join(dist, "screenshot.html");
const expectScreenshot = process.env.POS_SCREENSHOT_BUILD === "1";

if (expectScreenshot) {
  if (!existsSync(screenshot)) {
    console.error("POS_SCREENSHOT_BUILD=1 but dist/renderer/screenshot.html is missing");
    process.exit(1);
  }
} else if (existsSync(screenshot)) {
  console.error("Production renderer build must not include screenshot.html (use build:screenshot)");
  process.exit(1);
}
