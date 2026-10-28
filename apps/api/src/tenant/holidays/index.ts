import { parseHolidayYearFile, type HolidayYearList } from "./holiday-year-file";

export { parseHolidayYearFile, type HolidayYearList } from "./holiday-year-file";

/**
 * Every gazetted year in the repo, imported one by one so the build carries them and a typo
 * fails the tests rather than a branch's hours page. Each year is copied from that year's
 * gazette and checked by a person (README.md has the steps). A year without a file shows
 * "No holiday list for YYYY yet" in the editor. Never fill a year from anywhere but its gazette.
 */
// The 2026/2027 files are retained as drafts: both are copied from their gazettes but await a
// second person's check. Registering either here would present unchecked rows as gazette-backed
// suggestions.
export const HOLIDAY_YEAR_FILES: ReadonlyArray<readonly [file: string, data: unknown]> = [];

export function loadHolidayYears(
  files: ReadonlyArray<readonly [file: string, data: unknown]> = HOLIDAY_YEAR_FILES,
): ReadonlyMap<number, HolidayYearList> {
  const years = new Map<number, HolidayYearList>();
  for (const [file, data] of files) {
    const list = parseHolidayYearFile(data, file);
    if (file !== `lk-holidays-${list.year}.json`) {
      throw new Error(`Holiday list ${file} holds ${list.year}; name it lk-holidays-${list.year}.json`);
    }
    if (years.has(list.year)) throw new Error(`Holiday list ${file}: ${list.year} is already loaded`);
    years.set(list.year, list);
  }
  return years;
}
