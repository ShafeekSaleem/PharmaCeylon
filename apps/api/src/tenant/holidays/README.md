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
   - `source.copiedFrom`: `null` when you copied from the gazette itself. If you couldn't open the
     gazette and copied an official reproduction of it instead (the Central Bank's list, say), give
     that list's name and link, so the file doesn't pass for a check against the gazette.
   - `holidays`: one row per holiday the gazette lists. `date` is `YYYY-MM-DD`. `name` is the
     name as printed (80 characters at most). `kinds` lists the columns the gazette ticks, from
     `public`, `bank` and `mercantile`, plus `poya` for a Full Moon Poya Day. When the gazette puts
     two holidays on one date, add both rows; the editor offers them as one date.
   - `checkedBy` and `checkedOn`: who compared every row with the gazette, and when.
3. Have a second person compare every row with the gazette.
4. Import the file in `index.ts` and add it to `HOLIDAY_YEAR_FILES`.
5. Run `npx jest src/tenant/holidays` in `apps/api`. A typo, a date outside the year, an
   unknown field or a missing check fails the tests.

## The years in the repo

| Year | Gazette | Copied from | Status |
| --- | --- | --- | --- |
| 2026 | Extraordinary No. 2438/22 of 27 May 2025 | [CBSL, Bank Holidays for 2026](https://www.cbsl.gov.lk/en/about/about-the-bank/bank-holidays-2026) | Every row checked against the CBSL list (date, name, B/P/M marks, weekday). **Still to be compared with the gazette PDF.** |
| 2027 | Extraordinary No. 2493/05 (reported 6 July 2026) | [CBSL, Bank Holidays for 2027](https://www.cbsl.gov.lk/en/about/about-the-bank/bank-holidays-2027) | As 2026. The gazette's date and link still need filling in from the PDF. |

Both were copied on 27 October 2026, when documents.gov.lk couldn't be reached from where the files
were made. The Central Bank publishes the gazetted holidays for banks, marking each date B (bank),
P (public) and M (mercantile). Whoever compares these files with the gazette PDFs should fill in
anything missing, set `copiedFrom` to `null` and put their own name in `checkedBy`.

## Checking every year

Once a year, when the gazette for the coming year is out (by October at the latest), someone adds
that year and re-checks the current year's file against any amending gazette. A holiday declared
later, such as a special public holiday, goes in the file with its own gazette noted in `source.name`.
