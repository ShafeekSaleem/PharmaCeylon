const test = require("node:test");
const assert = require("node:assert/strict");
const { deriveSaleChannel } = require("../dist/sale-channel.js");

const notLive = { desktopPosRollout: "not_live", desktopPosLiveAt: null, posFallbackStartedAt: null, posFallbackEndsAt: null };
const live = {
  desktopPosRollout: "live",
  desktopPosLiveAt: "2026-06-01T00:00:00.000Z",
  posFallbackStartedAt: null,
  posFallbackEndsAt: null,
};

test("deriveSaleChannel", () => {
  assert.equal(
    deriveSaleChannel({ terminalId: null, offlineCommandId: "cmd", soldAt: "2026-10-01" }, notLive),
    "offline",
  );
  assert.equal(
    deriveSaleChannel({ terminalId: "t1", offlineCommandId: null, soldAt: "2026-10-01" }, notLive),
    "desktop_online",
  );
  assert.equal(
    deriveSaleChannel({ terminalId: null, offlineCommandId: null, soldAt: "2026-05-01" }, live),
    "web_legacy",
  );
  assert.equal(
    deriveSaleChannel({ terminalId: null, offlineCommandId: null, soldAt: "2026-07-01" }, live),
    "web_legacy",
  );
  const fallbackBranch = {
    ...live,
    posFallbackStartedAt: "2026-10-10T10:00:00.000Z",
    posFallbackEndsAt: "2026-10-10T18:00:00.000Z",
  };
  assert.equal(
    deriveSaleChannel({ terminalId: null, offlineCommandId: null, soldAt: "2026-10-10T12:00:00.000Z" }, fallbackBranch),
    "fallback",
  );
  assert.equal(
    deriveSaleChannel(
      { terminalId: null, offlineCommandId: null, soldAt: "2026-09-15T12:00:00.000Z" },
      live,
      [{ startedAt: new Date("2026-09-15T09:00:00.000Z"), endsAt: new Date("2026-09-15T17:00:00.000Z") }],
    ),
    "fallback",
  );
});