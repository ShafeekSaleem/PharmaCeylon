const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  defaultCounterPolicy,
  validateCounterPolicy,
  COUNTER_OFFLINE_RULES,
} = require("../dist");

test("new or unconfigured branches default to no offline authority", () => {
  assert.deepEqual(defaultCounterPolicy(), {
    schemaVersion: 1,
    offlineEnabled: false,
    offlineExternalCardEnabled: false,
    externalCardMerchants: [],
  });
  assert.equal(COUNTER_OFFLINE_RULES.permissionHours, 24);
  assert.equal(COUNTER_OFFLINE_RULES.snapshotFreshnessMinutes, 15);
});
test("normalizes merchants without changing the exact merchant identifier", () => {
  const doc = {
    ...defaultCounterPolicy(),
    externalCardMerchants: [
      { provider: "  Bank A  ", merchantId: "  AbC-1  " },
    ],
  };
  assert.deepEqual(validateCounterPolicy(doc).value.externalCardMerchants, [
    { provider: "Bank A", merchantId: "AbC-1" },
  ]);
});
test("rejects duplicate provider/merchant identity after whitespace/case normalization", () => {
  assert.equal(
    validateCounterPolicy({
      ...defaultCounterPolicy(),
      externalCardMerchants: [
        { provider: "Bank", merchantId: "1" },
        { provider: " bank ", merchantId: "1 " },
      ],
    }).ok,
    false,
  );
});
test("external card requires branch offline policy and a merchant", () => {
  assert.equal(
    validateCounterPolicy({
      ...defaultCounterPolicy(),
      offlineExternalCardEnabled: true,
    }).ok,
    false,
  );
  assert.equal(
    validateCounterPolicy({
      ...defaultCounterPolicy(),
      offlineEnabled: true,
      offlineExternalCardEnabled: true,
    }).ok,
    false,
  );
  assert.equal(
    validateCounterPolicy({
      ...defaultCounterPolicy(),
      offlineEnabled: true,
      offlineExternalCardEnabled: true,
      externalCardMerchants: [{ provider: "Bank", merchantId: "1" }],
    }).ok,
    true,
  );
});
test("rejects invented policy rules, malformed merchants and unbounded inputs", () => {
  for (const doc of [
    null,
    [],
    { ...defaultCounterPolicy(), permissionHours: 72 },
    { ...defaultCounterPolicy(), offlineEnabled: "false" },
    {
      ...defaultCounterPolicy(),
      externalCardMerchants: [{ provider: " ", merchantId: "1" }],
    },
    {
      ...defaultCounterPolicy(),
      externalCardMerchants: [{ provider: "Bank", merchantId: "1\n2" }],
    },
    {
      ...defaultCounterPolicy(),
      externalCardMerchants: Array.from({ length: 21 }, (_, i) => ({
        provider: "Bank",
        merchantId: String(i),
      })),
    },
  ]) {
    assert.equal(validateCounterPolicy(doc).ok, false);
  }
});
