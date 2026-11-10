const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  JOURNAL_CHAIN_PAGE_MAX,
  JOURNAL_RECOVERY_PAGE_MAX,
  continuesJournalChain,
} = require("../dist");

const hash = (c) => c.repeat(64);

test("a journal chain continues only from the exact position it names", () => {
  const entries = [
    { sequence: 4, previousCommandHash: hash("b") },
    { sequence: 5, previousCommandHash: hash("c") },
  ];
  assert.equal(
    continuesJournalChain({ sequence: 3, hash: hash("b") }, entries, [
      hash("c"),
      hash("d"),
    ]),
    true,
  );
  // Another entry at 4, a gap, or a different previous hash breaks it.
  assert.equal(
    continuesJournalChain({ sequence: 3, hash: hash("b") }, entries, [
      hash("x"),
      hash("d"),
    ]),
    false,
  );
  assert.equal(
    continuesJournalChain({ sequence: 2, hash: hash("b") }, entries, [
      hash("c"),
      hash("d"),
    ]),
    false,
  );
  assert.equal(
    continuesJournalChain({ sequence: 3, hash: hash("e") }, entries, [
      hash("c"),
      hash("d"),
    ]),
    false,
  );
  assert.equal(
    continuesJournalChain({ sequence: 3, hash: hash("b") }, entries, [
      hash("c"),
    ]),
    false,
  );
});

test("the empty journal starts the chain, and nothing continues trivially", () => {
  assert.equal(
    continuesJournalChain(
      { sequence: 0, hash: null },
      [{ sequence: 1, previousCommandHash: null }],
      [hash("a")],
    ),
    true,
  );
  assert.equal(
    continuesJournalChain(
      { sequence: 0, hash: null },
      [{ sequence: 1, previousCommandHash: hash("a") }],
      [hash("a")],
    ),
    false,
  );
  assert.equal(
    continuesJournalChain({ sequence: 7, hash: hash("a") }, [], []),
    true,
  );
});

test("recovery pages fit the API's request body limit", () => {
  assert.equal(JOURNAL_RECOVERY_PAGE_MAX, 25);
  assert.equal(JOURNAL_CHAIN_PAGE_MAX, 100);
});
