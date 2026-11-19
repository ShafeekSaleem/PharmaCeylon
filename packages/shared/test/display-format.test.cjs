const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DISPLAY_LOCALE, formatAmount, formatDayMonth, formatDisplayDate, formatDisplayDateTime,
  formatDisplayTime, formatMonthYear,
} = require('../dist/display-format.js');

// 13 Nov 2026, 14:05 in Colombo (UTC+5:30): the date a US-ordered screen would write 11/13/2026.
const at = '2026-11-13T08:35:00Z';
const tz = { timeZone: 'Asia/Colombo' };

test('dates are day-month, never month-first', () => {
  assert.equal(DISPLAY_LOCALE, 'en-GB');
  assert.equal(formatDisplayDate(at, tz), '13 Nov 2026');
  assert.equal(formatDayMonth(at, tz), '13 Nov');
  assert.equal(formatMonthYear(at, tz), 'November 2026');
});

test('times are 24-hour', () => {
  assert.equal(formatDisplayTime(at, tz), '14:05');
  assert.equal(formatDisplayDateTime(at, tz), '13 Nov 2026, 14:05');
  assert.equal(formatDisplayTime('2026-11-13T18:30:00Z', tz), '00:00');
});

test('a missing or unreadable date prints the fallback', () => {
  for (const v of [null, undefined, '', 'not a date']) {
    assert.equal(formatDisplayDate(v), '—');
    assert.equal(formatDisplayDateTime(v, { fallback: 'Never' }), 'Never');
  }
});

test('amounts use comma thousands and two decimals', () => {
  assert.equal(formatAmount(1234567.5), '1,234,567.50');
  assert.equal(formatAmount(0), '0.00');
  assert.equal(formatAmount(-12.345), '-12.35');
});
