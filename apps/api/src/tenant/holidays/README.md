# Sri Lanka holiday lists

The branch hours editor offers these holidays as dated exceptions. The owner ticks the ones that
apply and saves. Nothing is added to a branch by itself, and PharmaCeylon does not decide which
hours the law permits on a holiday.

There is one file per year, `lk-holidays-YYYY.json`, copied by hand from that year's government
gazette. If a year has no file, the editor says "No holiday list for YYYY yet" and suggests nothing
for that year. Dates are never guessed, so never fill a year from a calendar website, an earlier
year or memory.

## Where the list comes from

Each year the Ministry of Public Administration publishes the next year's public, bank and
mercantile holidays, Full Moon Poya Days included, as a Gazette Extraordinary under the Holidays
Act No. 29 of 1971. It is usually out a few months before the year starts. The Department of
Government Printing publishes the gazettes at <https://documents.gov.lk>.

## Adding a year

1. Find that year's holiday gazette and keep its number, its publication date and a link to it.
2. Copy `lk-holidays.template.json` to `lk-holidays-YYYY.json` and fill it in:
   - `year`: the year the holidays are in.
   - `source.name`: the gazette's number and title. `source.reference`: an https link to it, or
     `null`. `source.publishedOn`: its publication date, or `null`.
   - `holidays`: one row per holiday the gazette lists. `date` is `YYYY-MM-DD`. `name` is the
     name as printed (80 characters at most). `kinds` lists the columns the gazette ticks, from
     `public`, `bank` and `mercantile`, plus `poya` for a Full Moon Poya Day. When the gazette puts
     two holidays on one date, add both rows; the editor offers them as one date.
   - `checkedBy` and `checkedOn`: who compared every row with the gazette, and when.
3. Have a second person compare every row with the gazette.
4. Import the file in `index.ts` and add it to `HOLIDAY_YEAR_FILES`.
5. Run `npx jest src/tenant/holidays` in `apps/api`. A typo, a date outside the year, an
   unknown field or a missing check fails the tests.

## Checking every year

Once a year, when the gazette for the coming year is out (by October at the latest), someone adds
that year and re-checks the current year's file against any amending gazette. A holiday declared
later, such as a special public holiday, goes in the file with its own gazette noted in `source.name`.
