import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkStack, compose, validateBrowserConfig } from "./check-stack.mjs";
import { assertImage, docker, imageNames, inspect } from "./release-images.mjs";

export function assertContainerImage(container, image, revision, service) {
  assert.equal(container.Image, image.Id, `${service}: container is not running the selected release image`);
  assert.equal(container.Config.Labels?.["io.pharmaceylon.expected-revision"], revision, `${service}: container has a different release lock`);
}

function checkContainerImages(config, revision) {
  for (const service of Object.keys(imageNames)) {
    const ids = compose(["ps", "--all", "--quiet", service], { images: true }).trim().split(/\s+/).filter(Boolean);
    assert.equal(ids.length, 1, `${service}: expected exactly one release container`);
    const container = JSON.parse(docker(["container", "inspect", ids[0]]))[0];
    assertContainerImage(container, inspect(config.services[service].image), revision, service);
  }
}

export function validateImageConfig(config) {
  let revision;
  let registry;
  for (const [service, name] of Object.entries(imageNames)) {
    const entry = config.services[service];
    assert.ok(!entry.build, "Image-only Compose must not contain build instructions");
    const match = entry.image.match(new RegExp(`^(ghcr\\.io/shafeeksaleem|localhost:5000)/${name}@sha256:([a-f0-9]{64})$`));
    assert.ok(match, `${service}: use the digest-pinned release lock, not latest or mixed image names`);
    if (match[1] === "localhost:5000") assert.equal(process.env.GITHUB_ACTIONS, "true");
    registry ??= match[1];
    assert.equal(match[1], registry, "All images must come from one registry");
    const expected = entry.labels?.["io.pharmaceylon.expected-revision"];
    assert.match(expected ?? "", /^[a-f0-9]{40}$/);
    revision ??= expected;
    assert.equal(expected, revision, "Use one complete release lock");
  }
  validateBrowserConfig(config, { images: true });
  return revision;
}
export async function runImages(action) {
  const supported = ["config", "pull", "up", "check", "ps", "logs", "stop", "down"];
  assert.ok(supported.includes(action), `Choose ${supported.join(", ")}`);
  const config = JSON.parse(compose(["config", "--format", "json"], { images: true }));
  const revision = validateImageConfig(config);
  const run = (args) => compose(args, { images: true, capture: false });
  if (action === "config") return console.log("Digest-pinned image configuration is valid.");
  if (action === "pull" || action === "up") {
    run(["pull"]);
  }
  if (["pull", "up", "check"].includes(action)) {
    for (const service of Object.keys(imageNames)) assertImage(inspect(config.services[service].image), revision, service);
  }
  if (action === "up") {
    // Local update with a short outage: old API/web cannot serve during migration.
    run(["stop", "web", "api"]);
    run(["up", "-d", "--no-build", "--wait", "--wait-timeout", "180", "web"]);
    await checkStack({ images: true });
    checkContainerImages(config, revision);
  } else if (action === "check") {
    await checkStack({ images: true });
    checkContainerImages(config, revision);
  }
  else if (action === "ps") run(["ps", "--all"]);
  else if (action === "logs") run(["logs", "--follow", "--tail", "100"]);
  else if (action === "down" || action === "stop") run([action]);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runImages(process.argv[2]).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
