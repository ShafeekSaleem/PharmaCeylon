import { parseHolidayYearFile, type HolidayYearList } from "./holiday-year-file";
import lk2026 from "./lk-holidays-2026.json";
import lk2027 from "./lk-holidays-2027.json";

export { parseHolidayYearFile, type HolidayYearList } from "./holiday-year-file";

/**
 * Every gazetted year in the repo, imported one by one so the build carries them and a typo
 * fails the tests rather than a branch's hours page. Each year is copied from that year's
 * gazette and checked by a person (README.md has the steps). A year without a file shows
 * "No holiday list for YYYY yet" in the editor. Never fill a year from anywhere but its gazette.
 */
export const HOLIDAY_YEAR_FILES: ReadonlyArray<readonly [file: string, data: unknown]> = [
  ["lk-holidays-2026.json", lk2026],
  ["lk-holidays-2027.json", lk2027],
];

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
