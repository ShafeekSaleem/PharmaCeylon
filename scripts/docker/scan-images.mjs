import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { imageNames } from "./release-images.mjs";
import { root } from "./check-stack.mjs";

export function assessReport(report, image) {
  assert.equal(report.ArtifactName, image, "Scan report must match the expected image");
  assert.ok(Array.isArray(report.Results) && report.Results.length > 0, "Missing scan results must not pass");
  const findings = report.Results.flatMap((result) => result.Vulnerabilities ?? []);
  const severe = findings.filter((v) => ["HIGH", "CRITICAL"].includes(v.Severity));
  return { blocking: severe.filter((v) => Boolean(v.FixedVersion)), unfixed: severe.filter((v) => !v.FixedVersion) };
}
function scan() {
  const directory = path.join(root, "release");
  mkdirSync(directory, { recursive: true });
  let blocked = 0;
  for (const [service, name] of Object.entries(imageNames)) {
    const image = `${name}:local`;
    const report = path.join(directory, `scan-${service}.json`);
    for (const args of [
      ["image", "--scanners", "vuln", "--format", "json", "--output", report, image],
      ["image", "--format", "cyclonedx", "--output", path.join(directory, `sbom-${service}.json`), image],
    ]) {
      const result = spawnSync("trivy", [...args.slice(0, 1), "--timeout", "10m", ...args.slice(1)], { stdio: "inherit", timeout: 660_000, shell: false });
      assert.equal(result.status, 0, "Trivy execution or database download failed; do not publish unscanned images");
    }
    const policy = assessReport(JSON.parse(readFileSync(report, "utf8")), image);
    blocked += policy.blocking.length;
    console.log(`${service}: ${policy.blocking.length} fixable HIGH/CRITICAL findings block publication; ${policy.unfixed.length} unfixed HIGH/CRITICAL findings require review.`);
    for (const finding of [...policy.blocking, ...policy.unfixed]) {
      console.log(`${finding.Severity} ${finding.VulnerabilityID} ${finding.PkgName}@${finding.InstalledVersion} -> ${finding.FixedVersion || "no vendor fix recorded"}`);
    }
  }
  assert.equal(blocked, 0, `${blocked} fixable HIGH/CRITICAL findings block publication. See scan report artifacts; do not add blanket exclusions.`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { scan(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
