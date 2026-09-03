import * as XLSX from "xlsx";
import {
  IMPORT_FIELDS,
  type ImportField,
  type ImportMapping,
} from "./product-import.types";

/** Guard rail on a single upload — well past a realistic one-off migration file. */
export const MAX_IMPORT_ROWS = 20_000;

export type ParsedSheet = {
  headers: string[];
  /** One entry per data row: header → raw cell text (trimmed, never null). */
  rows: Array<Record<string, string>>;
};

/**
 * Read the first sheet of an .xlsx/.xls/.csv upload into headers + string rows.
 *
 * Deliberately stringly-typed: a customer export puts dates, quantities and prices in whatever
 * format its own system used, so every cell is normalised to text here and interpreted later
 * against the mapping the user confirmed. `cellDates` still gives us real Dates for genuine
 * date cells, which are formatted to ISO rather than being stringified by locale.
 */
export function parseSheet(buffer: Buffer, filename?: string): ParsedSheet {
  const isCsv = (filename ?? "").toLowerCase().endsWith(".csv");
  const wb = isCsv
    ? XLSX.read(buffer, { type: "buffer", raw: false, cellDates: true })
    : XLSX.read(buffer, { type: "buffer", cellDates: true });

  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error("The file has no sheets.");
  const sheet = wb.Sheets[sheetName];
  if (!sheet) throw new Error("The first sheet is empty.");

  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    blankrows: false,
    defval: null,
  });

  const headerRowIndex = matrix.findIndex(
    (row) => Array.isArray(row) && row.some((cell) => cellText(cell).length > 0),
  );
  if (headerRowIndex === -1) throw new Error("The file has no rows.");

  const rawHeaders = (matrix[headerRowIndex] ?? []).map((cell) => cellText(cell));
  // Blank trailing columns are common in exports; keep positions so row cells still line up.
  const headers = dedupeHeaders(rawHeaders);

  const rows: Array<Record<string, string>> = [];
  for (let i = headerRowIndex + 1; i < matrix.length; i += 1) {
    const raw = matrix[i];
    if (!Array.isArray(raw)) continue;
    const row: Record<string, string> = {};
    let hasValue = false;
    for (let c = 0; c < headers.length; c += 1) {
      const header = headers[c];
      if (!header) continue;
      const text = cellText(raw[c]);
      row[header] = text;
      if (text) hasValue = true;
    }
    if (hasValue) rows.push(row);
  }

  return { headers: headers.filter(Boolean), rows };
}

function cellText(cell: unknown): string {
  if (cell == null) return "";
  if (cell instanceof Date) {
    // Excel date cells arrive as local-midnight Dates; take the calendar date, not the instant.
    const y = cell.getFullYear();
    const m = String(cell.getMonth() + 1).padStart(2, "0");
    const d = String(cell.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(cell).replace(/\s+/g, " ").trim();
}

/** Two columns called "Price" would otherwise silently collapse into one. */
function dedupeHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((h) => {
    if (!h) return "";
    const count = seen.get(h) ?? 0;
    seen.set(h, count + 1);
    return count === 0 ? h : `${h} (${count + 1})`;
  });
}

/** Header text reduced to letters and digits, so "Pack Size" and "pack_size" match. */
function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Header aliases per field, most specific first. These are matched exactly against the
 * normalised header, then by prefix — "sellingpriceLKR" should still find `sellingPrice`,
 * but "price" must not win `costPrice` ahead of an explicit "costprice" column.
 */
const FIELD_ALIASES: Record<ImportField, string[]> = {
  name: ["productname", "itemname", "description", "product", "item", "name"],
  sku: ["sku", "itemcode", "productcode", "code", "stockcode"],
  barcode: ["barcode", "ean", "upc", "gtin", "scancode"],
  brandName: ["brand", "brandname", "tradename"],
  genericName: ["generic", "genericname", "molecule", "activeingredient", "ingredient"],
  manufacturer: ["manufacturer", "maker", "company", "mfr"],
  dosageForm: ["dosageform", "form", "dosage"],
  strength: ["strength", "potency", "dose"],
  unit: ["unit", "uom", "unitofmeasure"],
  packSize: ["packsize", "pack", "packing", "packaging"],
  registrationNo: ["registrationno", "regno", "registrationnumber", "nmrano", "nmra"],
  categoryName: ["category", "department", "group", "productcategory"],
  reorderLevel: ["reorderlevel", "reorderpoint", "minqty", "minimumqty", "reorder"],
  qty: ["qty", "quantity", "openingstock", "stock", "onhand", "qtyonhand", "balance"],
  costPrice: ["costprice", "cost", "buyingprice", "purchaseprice", "unitcost"],
  sellingPrice: ["sellingprice", "saleprice", "retailprice", "mrp", "price", "sellprice"],
  batchNo: ["batchno", "batch", "lot", "lotno", "batchnumber"],
  expiryDate: ["expirydate", "expiry", "expdate", "exp", "expiration", "bestbefore"],
};

/**
 * Best-guess mapping from the file's headers. Only ever a starting point — the user confirms
 * or corrects it on screen before anything is written, which is the whole reason this step
 * exists: the NMRA workbook has a fixed shape, a customer's export never does.
 */
export function suggestMapping(headers: string[]): ImportMapping {
  const mapping: ImportMapping = {};
  const taken = new Set<string>();
  const normalized = headers.map((h) => ({ header: h, key: normalizeHeader(h) }));

  // Exact alias hits first, so an explicit "Cost Price" column is claimed before the
  // prefix pass lets a bare "Price" compete for it.
  for (const field of IMPORT_FIELDS) {
    for (const alias of FIELD_ALIASES[field]) {
      const hit = normalized.find((h) => !taken.has(h.header) && h.key === alias);
      if (hit) {
        mapping[field] = hit.header;
        taken.add(hit.header);
        break;
      }
    }
  }

  for (const field of IMPORT_FIELDS) {
    if (mapping[field]) continue;
    for (const alias of FIELD_ALIASES[field]) {
      const hit = normalized.find(
        (h) => !taken.has(h.header) && h.key.length > 2 && h.key.includes(alias),
      );
      if (hit) {
        mapping[field] = hit.header;
        taken.add(hit.header);
        break;
      }
    }
  }

  return mapping;
}

/** Headers the suggestion couldn't place — shown so nothing looks silently dropped. */
export function unmappedHeaders(headers: string[], mapping: ImportMapping): string[] {
  const used = new Set(Object.values(mapping).filter(Boolean) as string[]);
  return headers.filter((h) => h && !used.has(h));
}

/**
 * Read a number out of a spreadsheet cell that may carry a currency label and either European
 * or Anglo thousands/decimal separators.
 *
 * The subtlety worth naming: a currency abbreviation ends in a full stop ("Rs. 410"), and
 * simply deleting the non-numeric characters turns that into ".410" — a price of 410 silently
 * becomes 0.41. Leading separators are stripped before anything is interpreted.
 */
function parseNumeric(text: string): number | null {
  if (!text) return null;

  // Drop currency symbols, letters and spaces, keeping only digits and separators.
  let cleaned = text.replace(/[^0-9.,\-]/g, "");
  // A sign is only a sign at the front.
  const negative = cleaned.startsWith("-");
  cleaned = cleaned.replace(/-/g, "");
  // "Rs. 410" is now ".410"; that stop belonged to the abbreviation, not to the number.
  cleaned = cleaned.replace(/^[.,]+/, "").replace(/[.,]+$/, "");
  if (!cleaned) return null;

  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");

  let normalized: string;
  if (lastComma >= 0 && lastDot >= 0) {
    // Both present: whichever comes last is the decimal separator ("1,250.50" / "1.250,50").
    const decimalAt = Math.max(lastComma, lastDot);
    normalized =
      cleaned.slice(0, decimalAt).replace(/[.,]/g, "") +
      "." +
      cleaned.slice(decimalAt + 1).replace(/[.,]/g, "");
  } else if (lastComma >= 0) {
    // One kind of separator. Two trailing digits reads as a decimal comma ("410,50");
    // anything else is a thousands group ("1,250").
    const tail = cleaned.length - lastComma - 1;
    const single = cleaned.indexOf(",") === lastComma;
    normalized =
      single && tail > 0 && tail <= 2
        ? cleaned.replace(",", ".")
        : cleaned.replace(/,/g, "");
  } else if (lastDot >= 0) {
    const tail = cleaned.length - lastDot - 1;
    const single = cleaned.indexOf(".") === lastDot;
    normalized = single && tail > 0 && tail <= 2 ? cleaned : cleaned.replace(/\./g, "");
  } else {
    normalized = cleaned;
  }

  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

export function parseQty(text: string): number | null {
  const value = parseNumeric(text);
  if (value == null) return null;
  return Math.trunc(value);
}

export function parseMoney(text: string): number | null {
  const value = parseNumeric(text);
  if (value == null || value < 0) return null;
  return Math.round(value * 100) / 100;
}

/**
 * Dates in a customer export are wildly inconsistent. Accept ISO, the day-first formats used
 * in Sri Lanka, and the month/year-only form that batch expiry is often written in ("03/2027",
 * "MAR-27") — for those, the last day of that month is the correct reading of the label.
 */
export function parseExpiry(text: string): Date | null {
  if (!text) return null;
  const value = text.trim();

  const iso = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(value);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    if (month < 1 || month > 12) return null;
    return iso[3] ? utcDate(year, month, Number(iso[3])) : endOfMonth(year, month);
  }

  const dmy = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/.exec(value);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    const year = expandYear(Number(dmy[3]));
    // Day-first is the Sri Lankan convention; fall back to month-first when day > 12 is
    // impossible but the second part is, e.g. "12/25/2027".
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return utcDate(year, month, day);
    if (day >= 1 && day <= 12 && month >= 1 && month <= 31) return utcDate(year, day, month);
    return null;
  }

  const my = /^(\d{1,2})[/.\-](\d{2,4})$/.exec(value);
  if (my) {
    const month = Number(my[1]);
    if (month < 1 || month > 12) return null;
    return endOfMonth(expandYear(Number(my[2])), month);
  }

  // "MAR-27" / "March 2027" — a month label, so the end of that month.
  const monthYear = /^([a-z]{3,9})[\s/.\-]*(\d{2,4})$/i.exec(value);
  if (monthYear) {
    const month = monthNumber(monthYear[1]);
    if (month) return endOfMonth(expandYear(Number(monthYear[2])), month);
    return null;
  }

  // "12 Mar 2027" — an exact date.
  const dayMonthYear =
    /^(\d{1,2})[\s/.\-]*([a-z]{3,9})[\s/.\-]*(\d{2,4})$/i.exec(value);
  if (dayMonthYear) {
    const month = monthNumber(dayMonthYear[2]);
    if (month) {
      return utcDate(expandYear(Number(dayMonthYear[3])), month, Number(dayMonthYear[1]));
    }
    return null;
  }

  return null;
}

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/**
 * Month names are matched explicitly rather than handed to `Date.parse`.
 *
 * `Date.parse` is lenient in ways that quietly corrupt an import: it reads "MAR-27" as the 27th
 * of March 2001 — dating live stock a quarter-century into the past, on one of the commonest
 * batch-expiry labels there is — and it turns "sometime 2027" into a real date rather than
 * refusing it. Anything this function doesn't recognise returns null, and the row is reported.
 */
function monthNumber(name: string): number | null {
  const key = name.toLowerCase();
  const index = MONTH_NAMES.findIndex(
    (m) => m === key || (key.length >= 3 && m.startsWith(key)),
  );
  return index === -1 ? null : index + 1;
}

function expandYear(year: number): number {
  if (year >= 1000) return year;
  // A two-digit expiry year is always in the future for stock a pharmacy is holding.
  return 2000 + year;
}

function utcDate(year: number, month: number, day: number): Date | null {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(d.getTime())) return null;
  if (d.getUTCMonth() !== month - 1) return null;
  return d;
}

function endOfMonth(year: number, month: number): Date {
  return new Date(Date.UTC(year, month, 0));
}
