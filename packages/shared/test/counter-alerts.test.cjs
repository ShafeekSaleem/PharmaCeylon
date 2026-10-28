const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  COUNTER_ALERT_TYPES,
  defaultCounterAlertPolicy,
  validateCounterAlertPolicy,
} = require("../dist");

test("by default every counter alert goes to owners and managers", () => {
  const policy = defaultCounterAlertPolicy();
  assert.equal(policy.rules.length, COUNTER_ALERT_TYPES.length);
  for (const rule of policy.rules) {
    assert.equal(rule.enabled, true);
    assert.deepEqual(rule.recipientRoleKeys, ["manager", "owner"]);
  }
  assert.equal(validateCounterAlertPolicy(policy).ok, true);
});

test("normalizes rule order and recipient order", () => {
  const rules = [...defaultCounterAlertPolicy().rules].reverse();
  rules[0] = { ...rules[0], recipientRoleKeys: ["pharmacist", "custom-lead"] };
  const parsed = validateCounterAlertPolicy({ schemaVersion: 1, rules });
  assert.deepEqual(
    parsed.value.rules.map((r) => r.type),
    [...COUNTER_ALERT_TYPES],
  );
  assert.deepEqual(parsed.value.rules.at(-1).recipientRoleKeys, ["custom-lead", "pharmacist"]);
});

test("a switched-off alert may have no recipients; a switched-on one may not", () => {
  const base = defaultCounterAlertPolicy();
  const withRule = (rule) => ({
    ...base,
    rules: base.rules.map((r, i) => (i === 0 ? { ...r, ...rule } : r)),
  });
  assert.equal(validateCounterAlertPolicy(withRule({ enabled: false, recipientRoleKeys: [] })).ok, true);
  assert.equal(validateCounterAlertPolicy(withRule({ enabled: true, recipientRoleKeys: [] })).ok, false);
});

test("refuses missing, duplicate or unknown types and malformed recipients", () => {
  const base = defaultCounterAlertPolicy();
  for (const doc of [
    null,
    { ...base, schemaVersion: 2 },
    { ...base, extra: true },
    { ...base, rules: base.rules.slice(1) },
    { ...base, rules: [...base.rules, base.rules[0]] },
    { ...base, rules: [...base.rules.slice(1), { ...base.rules[0], type: "web_pos" }] },
    { ...base, rules: [{ ...base.rules[0], enabled: "yes" }, ...base.rules.slice(1)] },
    { ...base, rules: [{ ...base.rules[0], recipientRoleKeys: ["owner", "owner"] }, ...base.rules.slice(1)] },
    { ...base, rules: [{ ...base.rules[0], recipientRoleKeys: ["Owner Name"] }, ...base.rules.slice(1)] },
    { ...base, rules: [{ ...base.rules[0], channel: "sms" }, ...base.rules.slice(1)] },
  ]) {
    assert.equal(validateCounterAlertPolicy(doc).ok, false, JSON.stringify(doc)?.slice(0, 80));
  }
});
