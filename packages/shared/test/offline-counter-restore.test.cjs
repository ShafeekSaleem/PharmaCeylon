const test = require('node:test');
const assert = require('node:assert/strict');
const {
  counterRestoreClockSkew: skew,
  COUNTER_CLOCK_TOLERANCE_MS: TOLERANCE,
} = require('../dist/offline-counter-restore.js');

const HOUR = 3_600_000;
const reportedAt = Date.UTC(2026, 10, 10, 10);

test('a counter whose clock agrees with itself and the server shows no skew', () => {
  assert.equal(skew({ backupTakenAt: reportedAt - 5 * HOUR, restoredAt: reportedAt - HOUR, reportedAt }), null);
  // A restore reported straight away, within the tolerance of a slightly fast clock.
  assert.equal(skew({ backupTakenAt: reportedAt - HOUR, restoredAt: reportedAt + TOLERANCE, reportedAt }), null);
});

test('a clock set back between the backup and the restore', () => {
  // A reset CMOS clock: the restore is dated years before the backup.
  const restoredAt = Date.UTC(2000, 0, 1);
  assert.deepEqual(skew({ backupTakenAt: reportedAt - HOUR, restoredAt, reportedAt }), {
    backupAfterRestoreMs: reportedAt - HOUR - restoredAt,
    aheadOfServerMs: 0,
  });
});

test('a fast clock corrected since the backup', () => {
  // The backup was dated two hours ahead; the restore, after the correction, is right.
  assert.deepEqual(skew({ backupTakenAt: reportedAt + 2 * HOUR, restoredAt: reportedAt - HOUR, reportedAt }), {
    backupAfterRestoreMs: 3 * HOUR,
    aheadOfServerMs: 2 * HOUR,
  });
});
