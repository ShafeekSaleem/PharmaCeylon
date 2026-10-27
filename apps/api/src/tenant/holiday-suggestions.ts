import { Injectable } from "@nestjs/common";
import { loadHolidayYears, type HolidayYearList } from "./holidays";

/**
 * Sri Lanka public, bank, mercantile and poya holidays, offered in the hours editor as dated
 * exceptions for the owner to confirm (D-W6). Nothing here is ever applied to a branch by itself.
 *
 * Each year comes from that year's government gazette, copied into `holidays/lk-holidays-YYYY.json`
 * and checked by a person (see `holidays/README.md`). A year with no file has no suggestions.
 * The app suggests holidays — it does not decide which hours the law permits.
 */
@Injectable()
export class HolidaySuggestionsSource {
  private readonly years = loadHolidayYears();

  forYear(year: number): HolidayYearList | null {
    return this.years.get(year) ?? null;
  }
}
