#!/usr/bin/env node
/**
 * Agent-only: renders deriveSyncState fixtures and saves PNGs under /opt/cursor/artifacts.
 * Not part of CI. Requires devDependencies `playwright` and `tsx` (or `npx tsx` on PATH).
 * Run from repo root: node apps/pos-desktop/scripts/sync-state-screenshots.mjs
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const outDir = "/opt/cursor/artifacts/sync-states";
fs.mkdirSync(outDir, { recursive: true });

const built = spawnSync(
  "npx",
  ["tsx", "apps/pos-desktop/scripts/sync-state-gallery-data.ts"],
  { cwd: repoRoot, encoding: "utf8", env: process.env },
);
if (built.status !== 0) {
  console.error(built.stderr || built.stdout);
  process.exit(built.status ?? 1);
}
const cases = JSON.parse(built.stdout);

const htmlPath = path.join(outDir, "gallery.html");
const casesJson = JSON.stringify(cases);
const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<link rel="stylesheet" href="${pathToFileURL(path.resolve(repoRoot, "apps/pos-desktop/src/renderer/src/tokens.css"))}">
<style>
body{margin:0;font:12px "Segoe UI",system-ui,sans-serif}
.win{width:1366px;height:768px;display:flex;flex-direction:column;background:var(--pos-canvas)}
.titlebar{display:flex;align-items:center;gap:12px;height:40px;padding:0 14px;background:var(--pos-chrome);border-bottom:1px solid var(--pos-chrome-line)}
.statusbar{display:flex;align-items:center;height:30px;padding:0 6px;background:var(--pos-chrome);border-top:1px solid var(--pos-chrome-line);font-size:11.5px;color:var(--pos-text-2)}
.grow{flex:1}
.conn{display:flex;align-items:center;gap:7px;padding:3px 10px 3px 9px;border-radius:999px;border:1px solid var(--pos-ok-line);background:var(--pos-ok-soft);color:var(--pos-ok-ink);font-size:12px;font-weight:600}
.connBad{border-color:var(--pos-bad-line);background:var(--pos-bad-soft);color:var(--pos-bad-ink);--dot:var(--pos-bad)}
.connWait{border-color:var(--pos-line);background:var(--pos-surface-3);color:var(--pos-text-2);--dot:var(--pos-text-3)}
.connInfo{border-color:var(--pos-info-line);background:var(--pos-info-soft);color:var(--pos-info-ink);--dot:var(--pos-info)}
.connWarn{border-color:var(--pos-warn-line);background:var(--pos-warn-soft);color:var(--pos-warn-ink);--dot:var(--pos-warn)}
.connDetail{font-weight:500;color:var(--pos-text-2)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--dot,var(--pos-ok));box-shadow:0 0 0 3px color-mix(in srgb,var(--dot,var(--pos-ok)) 22%,transparent)}
.sb{display:flex;align-items:center;gap:6px;padding:0 12px;border-right:1px solid var(--pos-line);white-space:nowrap}
.d{width:7px;height:7px;border-radius:50%;background:var(--d,var(--pos-text-3))}
.sbOk{--d:var(--pos-ok)}.sbBad{--d:var(--pos-bad)}.sbWait{--d:var(--pos-text-3)}.sbInfo{--d:var(--pos-info)}.sbWarn{--d:var(--pos-warn)}
.sbWarnText{color:var(--pos-warn-ink)}.sbMuted{color:var(--pos-text-3)}
.content{flex:1}
</style></head><body>
<div class="win" id="win"><header class="titlebar"><span>PharmaCeylon POS</span><span class="grow"></span><div id="pill"></div></header>
<div class="content"></div><footer class="statusbar" id="status"></footer></div>
<script>
const CASES=${casesJson};
const q=new URLSearchParams(location.search);
const c=CASES.find(x=>x.id===q.get('id'))||CASES[0];
document.documentElement.dataset.theme=q.get('theme')||'light';
const pill=document.getElementById('pill'); pill.className='conn '+c.connClass; pill.innerHTML=c.pillHtml;
const st=document.getElementById('status'); st.className='sb '+c.sbClass; st.innerHTML=c.statusHtml;
</script></body></html>`;
fs.writeFileSync(htmlPath, html);

const harryReviewIds = ["T7", "2", "attention", "5", "T2"];
const viewports = [
  { w: 1280, h: 720, tag: "1280x720" },
  { w: 1024, h: 640, tag: "1024x640" },
];
const browser = await chromium.launch();
for (const { w, h, tag } of viewports) {
  for (const theme of ["light", "dark"]) {
    for (const id of harryReviewIds) {
      if (!cases.some((c) => c.id === id)) continue;
      const page = await browser.newPage({ viewport: { width: w, height: h } });
      await page.goto(`${pathToFileURL(htmlPath)}?id=${encodeURIComponent(id)}&theme=${theme}`);
      await page.screenshot({ path: path.join(outDir, `pr171-${id}-${tag}-${theme}.png`) });
      await page.close();
    }
  }
}
await browser.close();
console.log(`Wrote ${harryReviewIds.length * viewports.length * 2} review PNGs to ${outDir}`);
