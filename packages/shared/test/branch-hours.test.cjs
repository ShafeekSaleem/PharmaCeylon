const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateBranchHours: validate, isNoSelling, sameMandatory, daysWithoutMandatoryTime, rangeSpan,
} = require('../dist/branch-hours.js');

const hours = (ranges) => ({ mode: 'hours', ranges });
function doc(overrides = {}) {
  const open = hours([{ opens: '08:00', closes: '20:00' }]);
  return {
    schemaVersion: 1,
    weekly: { mon: open, tue: open, wed: open, thu: open, fri: open, sat: open, sun: { mode: 'closed' } },
    exceptions: [],
    mandatory: null,
    ...overrides,
  };
}

test('a routine week with a closed day and no mandatory limit is valid', () => {
  const result = validate(doc());
  assert.equal(result.ok, true);
  assert.equal(result.value.mandatory, null);
  assert.deepEqual(result.value.weekly.sun, { mode: 'closed' });
});

test('24-hour days and overnight ranges are supported; a midnight close is written as 24:00', () => {
  const result = validate(doc({ weekly: { ...doc().weekly,
    fri: { mode: 'open_24h' },
    sat: hours([{ opens: '18:00', closes: '02:00' }, { opens: '08:00', closes: '12:00' }]),
    sun: hours([{ opens: '08:00', closes: '00:00' }]) } }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.weekly.fri, { mode: 'open_24h' });
  assert.deepEqual(result.value.weekly.sat.ranges.map((r) => r.opens), ['08:00', '18:00']);
  assert.deepEqual(result.value.weekly.sun.ranges, [{ opens: '08:00', closes: '24:00' }]);
  assert.deepEqual(rangeSpan('18:00', '02:00'), [1080, 1560]);
});

test('null mandatory means no limit; an empty list means no selling (D8)', () => {
  assert.equal(isNoSelling(validate(doc()).value), false);
  const none = validate(doc({ mandatory: [] }));
  assert.equal(none.ok, true);
  assert.deepEqual(none.value.mandatory, []);
  assert.equal(isNoSelling(none.value), true);
  assert.deepEqual(daysWithoutMandatoryTime([]).length, 7);
  assert.deepEqual(daysWithoutMandatoryTime(null), []);
});

test('mandatory windows are weekly, sorted, and checked for overlaps', () => {
  const result = validate(doc({ mandatory: [
    { day: 'tue', opens: '06:00', closes: '22:00' },
    { day: 'mon', opens: '06:00', closes: '22:00' },
  ] }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.mandatory.map((w) => w.day), ['mon', 'tue']);
  assert.deepEqual(daysWithoutMandatoryTime(result.value.mandatory), ['wed', 'thu', 'fri', 'sat', 'sun']);
  const overlap = validate(doc({ mandatory: [
    { day: 'mon', opens: '06:00', closes: '12:00' }, { day: 'mon', opens: '11:00', closes: '14:00' },
  ] }));
  assert.equal(overlap.ok, false);
  assert.match(overlap.errors.join(' '), /Mandatory limit on Monday: 06:00–12:00 overlaps 11:00–14:00/);
});

test('sameMandatory ignores order but not null versus empty', () => {
  const a = [{ day: 'mon', opens: '06:00', closes: '22:00' }, { day: 'sun', opens: '08:00', closes: '12:00' }];
  assert.equal(sameMandatory(a, [...a].reverse()), true);
  assert.equal(sameMandatory(null, []), false);
  assert.equal(sameMandatory(null, null), true);
  assert.equal(sameMandatory([], []), true);
});

test('missing or unknown fields are refused rather than defaulted', () => {
  const { mandatory, ...noMandatory } = doc();
  assert.equal(mandatory, null);
  assert.equal(validate(noMandatory).ok, false);
  assert.equal(validate({ ...doc(), extra: true }).ok, false);
  assert.equal(validate(doc({ weekly: { ...doc().weekly, mon: { mode: 'closed', ranges: [] } } })).ok, false);
  const { sun, ...sixDays } = doc().weekly;
  assert.ok(sun);
  assert.match(validate(doc({ weekly: sixDays })).errors.join(' '), /Sunday: hours are missing/);
  assert.equal(validate(doc({ schemaVersion: 2 })).ok, false);
});

test('bad times, equal times and overlapping ranges are explained per day', () => {
  const bad = (ranges) => validate(doc({ weekly: { ...doc().weekly, wed: hours(ranges) } }));
  assert.match(bad([{ opens: '8:00', closes: '20:00' }]).errors[0], /Wednesday: opening time must be HH:MM/);
  assert.match(bad([{ opens: '24:00', closes: '20:00' }]).errors[0], /opening time/);
  assert.match(bad([{ opens: '09:00', closes: '09:00' }]).errors[0], /can't be the same/);
  assert.match(bad([{ opens: '08:00', closes: '13:00' }, { opens: '12:00', closes: '18:00' }]).errors[0], /overlaps/);
  assert.match(bad([]).errors[0], /at least one opening time/);
  assert.equal(bad([1, 2, 3, 4, 5].map((h) => ({ opens: `0${h}:00`, closes: `0${h}:30` }))).ok, false);
});

test('dated exceptions are real, unique dates and holiday suggestions keep their key', () => {
  const closed = { mode: 'closed' };
  const ok = validate(doc({ exceptions: [
    { date: '2026-12-25', label: ' Christmas ', hours: closed, source: 'holiday_suggestion', holidayKey: 'lk:2026-12-25:christmas' },
    { date: '2026-11-03', label: 'Stocktake', hours: hours([{ opens: '08:00', closes: '12:00' }]), source: 'owner', holidayKey: null },
  ] }));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value.exceptions.map((e) => e.date), ['2026-11-03', '2026-12-25']);
  assert.equal(ok.value.exceptions[1].label, 'Christmas');

  const exception = (patch) => validate(doc({ exceptions: [
    { date: '2026-12-25', label: 'Christmas', hours: closed, source: 'owner', holidayKey: null, ...patch }] }));
  assert.equal(exception({ date: '2026-02-30' }).ok, false);
  assert.equal(exception({ label: '   ' }).ok, false);
  assert.equal(exception({ source: 'holiday_suggestion' }).ok, false);
  assert.equal(exception({ source: 'importer' }).ok, false);
  assert.equal(exception({ holidayKey: 'Has Spaces' }).ok, false);
  const twice = validate(doc({ exceptions: [
    { date: '2026-12-25', label: 'A', hours: closed, source: 'owner', holidayKey: null },
    { date: '2026-12-25', label: 'B', hours: closed, source: 'owner', holidayKey: null }] }));
  assert.match(twice.errors.join(' '), /already an exception for this date/);
});
