const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { isDailyWorkKind, DAILY_WORK_KINDS, SALES_RECOVERY_DAILY_WORK_KINDS } = require("../dist/dashboard.js");

const fixtureDir = path.join(__dirname, "..", "fixtures");
const baseline = JSON.parse(
  fs.readFileSync(path.join(fixtureDir, "daily-work-items-baseline.json"), "utf8"),
);
const recovery = JSON.parse(
  fs.readFileSync(path.join(fixtureDir, "daily-work-items-w11-sales-recovery.json"), "utf8"),
);

const LEGACY_KINDS = DAILY_WORK_KINDS.filter(
  (kind) => !(SALES_RECOVERY_DAILY_WORK_KINDS).includes(kind),
);

function isLegacyDailyWorkKind(value) {
  return LEGACY_KINDS.includes(value);
}

test("current registry includes sales recovery kinds", () => {
  for (const kind of SALES_RECOVERY_DAILY_WORK_KINDS) {
    assert.equal(isDailyWorkKind(kind), true);
  }
});

test("legacy desktop/mobile builds ignore unknown kinds but keep known rows", () => {
  const merged = [...baseline, ...recovery];
  const legacyVisible = merged.filter((row) => isLegacyDailyWorkKind(row.kind));
  assert.deepEqual(
    legacyVisible.map((row) => row.kind),
    baseline.map((row) => row.kind),
  );
  for (const row of recovery) {
    assert.equal(isLegacyDailyWorkKind(row.kind), false);
    assert.equal(isDailyWorkKind(row.kind), true);
  }
});