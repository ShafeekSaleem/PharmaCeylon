# Sri Lanka holiday lists

The branch hours editor offers these holidays as dated exceptions. The owner ticks the ones that
apply and saves. Nothing is added to a branch by itself, and PharmaCeylon does not decide which
hours the law permits on a holiday.

There is one file per year, `lk-holidays-YYYY.json`, copied by hand from that year's government
gazette. Only verified files registered in `HOLIDAY_YEAR_FILES` are offered. If a year has no
registered file, the editor says "No holiday list for YYYY yet" and suggests nothing
for that year. Dates are never guessed, so never fill a year from a calendar website, an earlier
year or memory.

## Where the list comes from

Each year the Ministry of Public Administration publishes the next year's holidays, Full Moon Poya
Days included, as a Gazette Extraordinary under the Holidays Act No. 29 of 1971. The 2026 gazette
declares them public and bank holidays only; record `mercantile` only for a gazette that marks it. It is usually out a few months before the year starts. The Department of
Government Printing publishes the gazettes at <https://documents.gov.lk>.

## Adding a year

1. Find that year's holiday gazette and keep its number, its publication date and a link to it.
2. Copy `lk-holidays.template.json` to `lk-holidays-YYYY.json` and fill it in:
   - `year`: the year the holidays are in.
   - `source.name`: the gazette's number and title. `source.reference`: an https link to it.
     `source.publishedOn`: its publication date. Both are required before registration.
   - `source.copiedFrom`: `null` when you copied from the gazette itself. If you couldn't open the
     gazette and copied an official reproduction of it instead (the Central Bank's list, say), give
     that list's name and link. Such a file is a draft and cannot be loaded. After completing
     the comparison with the gazette, set this to `null`.
   - `holidays`: one row per holiday the gazette lists. `date` is `YYYY-MM-DD`. `name` is the
     name as printed (80 characters at most). `kinds` lists the columns the gazette ticks, from
     `public`, `bank` and `mercantile`, plus `poya` for a Full Moon Poya Day. When the gazette puts
     two holidays on one date, add both rows; the editor offers them as one date.
   - `checkedBy` and `checkedOn`: who compared every row with the gazette, and when.
3. Have a second person compare every row with the gazette.
4. Only after that comparison, import the file in `index.ts` and add it to `HOLIDAY_YEAR_FILES`.
5. Run `npx jest src/tenant/holidays` in `apps/api`. A typo, a date outside the year, an
   unknown field or a missing check fails the tests.

## Years in the repo

Both years are registered in `HOLIDAY_YEAR_FILES` and offered in the hours editor. Each was compared
row by row with its gazette PDF by Claude Code on 28 October 2026 and accepted for release by
Shafeek Saleem without a separate row-by-row check by a second person, as `checkedBy` records.

| Year | Gazette | Notes |
| --- | --- | --- |
| 2026 | Extraordinary No. 2438/22 of 27 May 2025, amended by No. 2485/14 of 21 April 2026 | Names as printed, every 2438/22 date marked public and bank. 2485/14 (Vesak Week, 27 May–2 June) moves "the public holiday granted for 2nd May 2026" to 31 May. The file reads that as: 2 May keeps only `bank` and 31 May is `public` only. The order names no holiday for 31 May. |
| 2027 | Extraordinary No. 2493/05 of 16 June 2026 | Names as printed, every date marked public and bank. No amending gazette found as of 28 October 2026. |

The 2026 and 2027 gazettes both declare their dates "Public and Bank Holidays" and mark each with only
those two symbols, so neither file has `mercantile` rows. The Central Bank's list also marks some
dates M (mercantile); those marks come from elsewhere and are not copied into a gazette file.

On the new documents.gov.lk the old `view/extra-gazettes/...` links return 404. Find the gazette under
Publications → Extra Gazettes (filter by year and month, search "Holiday") and use the English PDF's
`api/content-file-proxy` link. That link carries an upload timestamp and may change again; the
gazette number and date in `source.name` are the lasting reference, and are enough to find it.

## Checking every year

Once a year, when the gazette for the coming year is out (by October at the latest), someone adds
that year and re-checks the current year's file against any amending gazette. A holiday declared
later, such as a special public holiday, goes in the file with its own gazette noted in `source.name`.
