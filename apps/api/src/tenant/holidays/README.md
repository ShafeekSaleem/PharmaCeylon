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

## Draft years in the repo

Neither draft below is registered or offered by the API. The loader rejects pending verification,
secondary-source copies, and missing gazette metadata. Keep the drafts out of `HOLIDAY_YEAR_FILES`
until a person has compared every row with the original gazette and recorded the completed check.
Owners may enter dated exceptions manually in the meantime.

| Year | Gazette | Copied from | Status |
| --- | --- | --- | --- |
| 2026 | Extraordinary No. 2438/22 of 27 May 2025, amended by No. 2485/14 of 21 April 2026 | — (the gazettes) | Copied from both PDFs on 28 October 2026: names as printed, every 2438/22 date marked public and bank. 2485/14 (Vesak Week, 27 May–2 June) moves "the public holiday granted for 2nd May 2026" to 31 May, so 2 May keeps only `bank` and 31 May is `public` only; the order names no holiday for 31 May. **Before registering:** the second person confirms that reading (in particular that 2 May stays a bank holiday), re-searches the Extra Gazettes for later amendments, and records their name in `checkedBy` and the date in `checkedOn`. |
| 2027 | Extraordinary No. 2493/05 of 16 June 2026 (listed on documents.gov.lk, not yet compared) | [CBSL, Bank Holidays for 2027](https://www.cbsl.gov.lk/en/about/about-the-bank/bank-holidays-2027) | Every row checked against the CBSL list. The gazette's date and link still need filling in from the PDF. |

The 2027 file was copied on 27 October 2026, when documents.gov.lk couldn't be reached. The Central
Bank's list marks each date B (bank), P (public) and M (mercantile). Whoever compares it with the
gazette PDF should copy names as printed, keep only the kinds the gazette gives, fill in anything
missing, set `copiedFrom` to `null` and put their own name in `checkedBy`.

The 2026 gazette declares its dates "Public and Bank Holidays" and marks each with only those two
symbols, so its file has no `mercantile` rows. The Central Bank's M marks come from elsewhere and are
not copied into a gazette file.

On the new documents.gov.lk the old `view/extra-gazettes/...` links return 404. Find the gazette under
Publications → Extra Gazettes (filter by year and month, search "Holiday") and use the English PDF's
`api/content-file-proxy` link. That link carries an upload timestamp and may change again; the
gazette number and date in `source.name` are the lasting reference, and are enough to find it.

## Checking every year

Once a year, when the gazette for the coming year is out (by October at the latest), someone adds
that year and re-checks the current year's file against any amending gazette. A holiday declared
later, such as a special public holiday, goes in the file with its own gazette noted in `source.name`.
