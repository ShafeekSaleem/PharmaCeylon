// A successful direct push is not sufficient to publish. Require a merged PR.
import assert from "node:assert/strict";

try {
  assert.equal(process.env.GITHUB_EVENT_NAME, "push");
  assert.equal(process.env.GITHUB_REF, "refs/heads/main");
  assert.equal(process.env.GITHUB_REPOSITORY, "ShafeekSaleem/PharmaCeylon");
  const sha = process.env.GITHUB_SHA;
  assert.match(sha ?? "", /^[a-f0-9]{40}$/);
  assert.ok(process.env.GH_TOKEN, "Temporary read token is required");
  const response = await fetch(`https://api.github.com/repos/ShafeekSaleem/PharmaCeylon/commits/${sha}/pulls?per_page=100`, {
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    signal: AbortSignal.timeout(15_000), redirect: "error",
  });
  assert.equal(response.status, 200, "Could not verify merged PR provenance");
  const prs = await response.json();
  assert.ok(prs.some((pr) => pr.merged_at && pr.merge_commit_sha === sha && pr.base?.ref === "main" && pr.base?.repo?.full_name === "ShafeekSaleem/PharmaCeylon"), "Publication requires a merged PR whose merge commit is this main commit");
  console.log("Verified merged PR provenance for publication.");
} catch (error) { console.error(error.message); process.exitCode = 1; }
