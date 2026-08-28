import assert from "node:assert/strict";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { root } from "./check-stack.mjs";
import { docker, exportImages, publishImages } from "./release-images.mjs";
import { testBundle } from "./test-image-bundle.mjs";

async function main() {
  assert.equal(process.env.GITHUB_ACTIONS, "true", "Local registry tests are CI-only");
  assert.match(process.env.GITHUB_RUN_ID ?? "", /^\d+$/);
  const container = `pharmaceylon-registry-${process.env.GITHUB_RUN_ID}`;
  const directory = path.join(root, "release", "local-registry");
  try {
    docker(["run", "--detach", "--name", container, "--publish", "127.0.0.1:5000:5000", "registry:2"], { capture: false });
    let ready = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      try { ready = (await fetch("http://127.0.0.1:5000/v2/", { signal: AbortSignal.timeout(1_000) })).ok; } catch {}
      if (ready) break;
      await setTimeout(1_000);
    }
    assert.ok(ready, "Disposable registry did not become ready");
    exportImages(directory, process.env.GITHUB_SHA, { archive: false });
    publishImages(directory, { registry: "localhost:5000", revision: process.env.GITHUB_SHA, run: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT });
    testBundle(path.join(directory, "bundle"));
    console.log("PASS: all three tested images pushed, pulled by digest, and verified through the image-only bundle.");
  } finally {
    docker(["rm", "--force", "--volumes", container], { capture: false });
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
