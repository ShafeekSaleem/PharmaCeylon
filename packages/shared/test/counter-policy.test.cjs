const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  defaultCounterPolicy,
  validateCounterPolicy,
  parseStoredCounterPolicy,
  COUNTER_OFFLINE_RULES,
} = require("../dist");

test("new or unconfigured branches default to no offline authority", () => {
  assert.deepEqual(defaultCounterPolicy(), {
    schemaVersion: 2,
    onlinePaymentMethods: ["card", "mobile_wallet", "credit"],
    offlineEnabled: false,
    offlineExternalCardEnabled: false,
    externalCardMerchants: [],
    registerNumbering: [],
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

const reg1 = "11111111-1111-4111-8111-111111111111";
const reg2 = "22222222-2222-4222-8222-222222222222";

test("upgrades a stored version 1 document without changing its offline choices", () => {
  const stored = {
    schemaVersion: 1,
    offlineEnabled: true,
    offlineExternalCardEnabled: true,
    externalCardMerchants: [{ provider: "Bank", merchantId: "M1" }],
  };
  assert.deepEqual(parseStoredCounterPolicy(stored).value, {
    ...defaultCounterPolicy(),
    offlineEnabled: true,
    offlineExternalCardEnabled: true,
    externalCardMerchants: [{ provider: "Bank", merchantId: "M1" }],
  });
  // Writes must send version 2; a version 1 document is only accepted from storage.
  assert.equal(validateCounterPolicy(stored).ok, false);
  assert.equal(parseStoredCounterPolicy({ ...stored, permissionHours: 72 }).ok, false);
});

test("cash can't be switched off, so payments can never stop a branch selling", () => {
  assert.equal(
    validateCounterPolicy({ ...defaultCounterPolicy(), onlinePaymentMethods: ["cash", "card"] }).ok,
    false,
  );
  assert.deepEqual(
    validateCounterPolicy({ ...defaultCounterPolicy(), onlinePaymentMethods: [] }).value.onlinePaymentMethods,
    [],
  );
  assert.deepEqual(
    validateCounterPolicy({ ...defaultCounterPolicy(), onlinePaymentMethods: ["credit", "card"] }).value
      .onlinePaymentMethods,
    ["card", "credit"],
  );
  for (const methods of [["card", "card"], ["bitcoin"], "card", undefined]) {
    assert.equal(validateCounterPolicy({ ...defaultCounterPolicy(), onlinePaymentMethods: methods }).ok, false);
  }
});

test("normalizes register prefixes and refuses series that could collide", () => {
  const ok = validateCounterPolicy({
    ...defaultCounterPolicy(),
    registerNumbering: [
      { registerId: reg1.toUpperCase(), receiptPrefix: " c1r- ", invoicePrefix: "c1i-" },
      { registerId: reg2, receiptPrefix: "C2R-", invoicePrefix: "C2I-" },
    ],
  });
  assert.deepEqual(ok.value.registerNumbering, [
    { registerId: reg1, receiptPrefix: "C1R-", invoicePrefix: "C1I-" },
    { registerId: reg2, receiptPrefix: "C2R-", invoicePrefix: "C2I-" },
  ]);
  const numbering = (rows) => validateCounterPolicy({ ...defaultCounterPolicy(), registerNumbering: rows });
  for (const rows of [
    // one prefix begins another
    [
      { registerId: reg1, receiptPrefix: "C1", invoicePrefix: "D1" },
      { registerId: reg2, receiptPrefix: "C10", invoicePrefix: "D2" },
    ],
    // receipt and invoice series of one register are the same
    [{ registerId: reg1, receiptPrefix: "C1", invoicePrefix: "C1" }],
    // overlaps the online INV- series
    [{ registerId: reg1, receiptPrefix: "INV-C1-", invoicePrefix: "D1" }],
    [{ registerId: reg1, receiptPrefix: "IN", invoicePrefix: "D1" }],
    // same register twice, malformed IDs and prefixes
    [
      { registerId: reg1, receiptPrefix: "A", invoicePrefix: "B" },
      { registerId: reg1, receiptPrefix: "C", invoicePrefix: "D" },
    ],
    [{ registerId: "till-1", receiptPrefix: "A", invoicePrefix: "B" }],
    [{ registerId: reg1, receiptPrefix: "", invoicePrefix: "B" }],
    [{ registerId: reg1, receiptPrefix: "-A", invoicePrefix: "B" }],
    [{ registerId: reg1, receiptPrefix: "A B", invoicePrefix: "C" }],
    [{ registerId: reg1, receiptPrefix: "ABCDEFGHIJKLM", invoicePrefix: "C" }],
    [{ registerId: reg1, receiptPrefix: "A", invoicePrefix: "B", nextNumber: 1 }],
  ]) {
    assert.equal(numbering(rows).ok, false, JSON.stringify(rows));
  }
});
