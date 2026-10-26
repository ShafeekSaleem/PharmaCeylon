import { Injectable } from "@nestjs/common";
import type { HolidaySuggestion, HolidaySuggestionsView } from "@pharmaceylon/shared";

/**
 * Sri Lanka public, bank, mercantile and poya holidays, offered in the hours editor as dated
 * exceptions for the owner to confirm (D-W6). Nothing here is ever applied to a branch by itself.
 *
 * Deliberately empty: no date is added until the source for them has been agreed. Whichever
 * source is chosen, only this class changes; the API shape and the editor stay the same. The
 * app suggests holidays — it does not decide which hours the law permits.
 */
@Injectable()
export class HolidaySuggestionsSource {
  list(): HolidaySuggestionsView {
    return { source: null, holidays: [] satisfies HolidaySuggestion[] };
  }
}
