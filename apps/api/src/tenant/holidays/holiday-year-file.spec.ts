import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOLIDAY_YEAR_FILES, loadHolidayYears, parseHolidayYearFile } from ".";

// Fixture data in a far-off year. These are not real holiday dates.
function yearFile(overrides: Record<string, unknown> = {}) {
  return {
    year: 2099,
    source: { name: "Test gazette 2099", reference: "https://example.test/gazette.pdf", publishedOn: "2098-09-01" },
    checkedBy: "Test Reviewer",
    checkedOn: "2098-09-05",
    holidays: [
      { date: "2099-03-10", name: "Test Poya Day", kinds: ["poya", "public", "bank"] },
      { date: "2099-01-14", name: "Test Festival", kinds: ["public", "bank", "mercantile"] },
      { date: "2099-03-10", name: "Test Second Holiday", kinds: ["public", "mercantile"] },
    ],
    ...overrides,
  };
}
const parse = (data: unknown, file = "lk-holidays-2099.json") => parseHolidayYearFile(data, file);

it("reads a year, sorted by date, merging holidays that share a date into one suggestion", () => {
  const list = parse(yearFile());
  expect(list.year).toBe(2099);
  expect(list.source).toEqual({ name: "Test gazette 2099", reference: "https://example.test/gazette.pdf", checkedOn: "2098-09-05" });
  expect(list.holidays).toEqual([
    { key: "lk:2099-01-14", date: "2099-01-14", name: "Test Festival", kinds: ["public", "bank", "mercantile"] },
    {
      key: "lk:2099-03-10",
      date: "2099-03-10",
      name: "Test Poya Day / Test Second Holiday",
      kinds: ["public", "poya", "bank", "mercantile"],
    },
  ]);
});

it.each([
  ["a date outside the year", { holidays: [{ date: "2098-12-31", name: "x", kinds: ["public"] }] }, /real date in 2099/],
  ["an impossible date", { holidays: [{ date: "2099-02-30", name: "x", kinds: ["public"] }] }, /real date in 2099/],
  ["an unknown kind", { holidays: [{ date: "2099-01-01", name: "x", kinds: ["sunday"] }] }, /kinds must list/],
  ["a repeated kind", { holidays: [{ date: "2099-01-01", name: "x", kinds: ["public", "public"] }] }, /once each/],
  ["no holidays at all", { holidays: [] }, /must list the year's holidays/],
  ["a repeated row", { holidays: [
    { date: "2099-01-01", name: "x", kinds: ["public"] }, { date: "2099-01-01", name: "x", kinds: ["bank"] }] }, /repeats x/],
  ["nobody having checked it", { checkedBy: " " }, /checkedBy/],
  ["a link that isn't https", { source: { name: "G", reference: "http://example.test", publishedOn: null } }, /https link/],
  ["an unknown field", { notes: "x" }, /unexpected notes/],
  ["a joined name too long for an exception", { holidays: [
    { date: "2099-01-01", name: "A".repeat(45), kinds: ["public"] },
    { date: "2099-01-01", name: "B".repeat(45), kinds: ["public"] }] }, /shorten the names/],
])("refuses %s", (_label, overrides, message) => {
  expect(() => parse(yearFile(overrides))).toThrow(message);
});

it("reports every problem in a file at once", () => {
  expect(() => parse(yearFile({ year: 99, checkedOn: "soon" }))).toThrow(/year must be.*\n- checkedOn must be/s);
});

it("refuses a file whose name doesn't match its year, or a year loaded twice", () => {
  expect(() => loadHolidayYears([["lk-holidays-2098.json", yearFile()]])).toThrow(/name it lk-holidays-2099.json/);
  expect(() =>
    loadHolidayYears([
      ["lk-holidays-2099.json", yearFile()],
      ["lk-holidays-2099.json", yearFile()],
    ]),
  ).toThrow(/already loaded/);
  expect(loadHolidayYears([["lk-holidays-2099.json", yearFile()]]).get(2099)?.holidays).toHaveLength(2);
});

it("loads every year file in the repo (none until a year is copied from its gazette)", () => {
  expect(HOLIDAY_YEAR_FILES).toEqual([]);
  expect(loadHolidayYears().size).toBe(0);
});

it("keeps the template unusable until it is filled in from a gazette", () => {
  const template = JSON.parse(readFileSync(join(__dirname, "lk-holidays.template.json"), "utf8"));
  expect(Object.keys(template).sort()).toEqual(["checkedBy", "checkedOn", "holidays", "source", "year"]);
  expect(() => parse(template, "lk-holidays.template.json")).toThrow(/year must be a four-digit year/);
});
