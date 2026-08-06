import { randomUUID } from "crypto";
import * as XLSX from "xlsx";

/** Stable demo keys used by operational seed scenarios (stock, POs, sales). */
export const DEMO_STOCK_REG_NOS: Record<string, string> = {
  "PCL-0001": "M009669",
  "PCL-0002": "M011371",
  "PCL-0003": "M009358",
  "PCL-0004": "M009266",
  "PCL-0005": "M011663",
  "PCL-0006": "M010240",
  "PCL-0007": "M009624",
  "PCL-0008": "M009262",
  "PCL-0009": "M011130",
  "PCL-0010": "M009201",
  "PCL-0011": "M009796",
  "PCL-0012": "M010082",
  "PCL-0013": "M010653",
  "PCL-0014": "M009496",
  "PCL-0015": "M009985",
  "PCL-0016": "M009820",
  "PCL-0017": "M013759",
  "PCL-0018": "M013180",
  "PCL-0019": "M009970",
  "PCL-0020": "M013913",
  "PCL-0021": "M009833",
  "PCL-0022": "M011580",
  "PCL-0023": "M016507",
  "PCL-0024": "M009924",
  "PCL-0025": "M010520",
  "PCL-0026": "M009340",
  "PCL-0027": "M008690",
  "PCL-0028": "M011233",
  "PCL-0029": "M010846",
  "PCL-0030": "M009616",
};

const CONTROLLED_NAME_RE =
  /\b(MORPHINE|DIAZEPAM|CODEINE|FENTANYL|PETHIDINE|METHADONE|OXYCODONE|TRAMADOL|KETAMINE|MIDAZOLAM|PHENOBARBITAL|PHENOBARBITONE|ALPRAZOLAM|LORAZEPAM|CLONAZEPAM|NITRAZEPAM)\b/i;

const STRENGTH_RE =
  /(\d+(?:\.\d+)?\s*(?:MG|MCG|µg|UG|G|ML|IU|UNITS?|%|W\/W|W\/V)(?:\s*\/\s*\d+(?:\.\d+)?\s*(?:ML|G))?)/i;

/**
 * Trailing strength on brand strings, e.g. "Vermor SR 60" / "Panadol 500mg" / "VERMOR-30".
 * Unit-less single digits (e.g. "VERMOR 1") are kept — they are brand variants, not strengths.
 */
const TRAILING_BRAND_STRENGTH_RE =
  /(?:\s+|-)(\d+(?:\.\d+)?)(\s*(?:MG|MCG|µg|UG|G|ML|IU|%|MG\/ML|MCG\/ML))?$/i;

export const UNBRANDED_BRAND_LABEL = "UNBRANDED";

export const SCHEDULE_LABELS: Record<string, string> = {
  I: "I — Grocery / general retail",
  "II A": "II A — Pharmacy OTC",
  "II B": "II B — Prescription only",
  "II C": "II C — Controlled prescription",
  III: "III — Narcotic (Osusala)",
};

/** Target size for expanded demo inventory (beyond the 30 PCL ops keys). */
/** Sellable / stocked SKUs for demos & dashboards (stratified from full NMRA catalog). */
export const EXPANDED_DEMO_STOCK_TARGET = 750;

export type NmraProductRow = {
  id: string;
  sku: string;
  name: string;
  brandName: string | null;
  genericName: string | null;
  manufacturer: string | null;
  dosageForm: string | null;
  dosageFormGroup: string;
  strength: string | null;
  unit: string | null;
  packSize: string | null;
  packType: string | null;
  barcode: string | null;
  registrationNo: string;
  registrationDate: Date | null;
  schedule: string | null;
  scheduleGroup: string | null;
  regType: string | null;
  dossierNo: string | null;
  countryOfOrigin: string | null;
  localAgent: string | null;
  isControlled: boolean;
  requiresPrescription: boolean;
  isUnbranded: boolean;
  isActive: boolean;
  reorderLevel: number;
};

export function clean(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).replace(/\s+/g, " ").trim();
  // *** / **** / ***** = SPC / unbranded placeholders in NMRA export
  if (!s || /^\*+$/.test(s) || s === "-" || s.toUpperCase() === "N/A" || s === ".") {
    return null;
  }
  return s;
}

/** Catalog display fields stay ALL CAPS to match NMRA source style. */
export function catalogCaps(s: string): string {
  return s.replace(/\s+/g, " ").trim().toUpperCase();
}

/**
 * Coded / non-trade brands in NMRA: "10 D", "1000D", "20M", "45", "5D".
 * These are not real trade names — product display should use the generic name.
 */
export function isCodedBrandName(brand: string): boolean {
  const s = brand.replace(/\s+/g, " ").trim().toUpperCase();
  // Pure number, or number + optional short letter token (D, M, IU, etc.)
  if (/^\d+([.\d]*)?(\s*[A-Z]{1,3})?$/.test(s)) return true;
  // Compact forms like 1000D / 20M / 5D
  if (/^\d+[A-Z]{1,3}$/.test(s)) return true;
  return false;
}

/**
 * Split trade name from trailing strength so brand stays shared across strengths.
 * "VERMOR SR 60" → brand "VERMOR SR", product name "VERMOR SR 60"
 * "VERMOR 1" → brand "VERMOR 1" (single-digit unit-less token kept as brand)
 */
export function splitBrandAndProductName(brandRaw: string): {
  brandName: string;
  productName: string;
} {
  const caps = catalogCaps(brandRaw);
  const match = caps.match(TRAILING_BRAND_STRENGTH_RE);
  if (!match || match.index == null) {
    return { brandName: caps, productName: caps };
  }
  const base = caps.slice(0, match.index).trim();
  if (base.length < 2 || isCodedBrandName(caps) || isCodedBrandName(base)) {
    return { brandName: caps, productName: caps };
  }
  if (/^\d+([.\d]*)?$/.test(base)) {
    return { brandName: caps, productName: caps };
  }
  const num = match[1]!;
  const unitRaw = match[2] ?? "";
  const unit = unitRaw.replace(/\s+/g, "").toUpperCase();
  // Unit-less single digit (1–9) is usually a brand line suffix, not a strength.
  if (!unit && /^\d$/.test(num)) {
    return { brandName: caps, productName: caps };
  }
  return {
    brandName: base,
    productName: `${base} ${num}${unit}`.replace(/\s+/g, " ").trim(),
  };
}

export function normalizeSchedule(raw: string | null): string | null {
  if (!raw) return null;
  const compact = raw.toUpperCase().replace(/\s+/g, "");
  // Common OCR / export typos (1 vs I).
  const fixed = compact.replace(/^1(?=I|[ABC]|$)/, "I").replace(/11B/, "IIB").replace(/I1B/, "IIB");
  if (fixed === "I" || fixed === "IB") return "I";
  if (fixed === "IIA" || fixed === "II") return "II A";
  if (fixed === "IIB" || fixed === "IIB.") return "II B";
  if (fixed === "IIC") return "II C";
  if (fixed === "III") return "III";
  // Drop pack-size / garbage values that appear in the SCHEDULE column.
  if (!/^I{1,3}[ABC]?$/.test(fixed) && !/^SCHEDULE/.test(fixed)) return null;
  return raw.replace(/\s+/g, " ").trim().toUpperCase();
}

export function normalizeDosageFormGroup(dosage: string | null, generic: string | null): string {
  const text = `${dosage ?? ""} ${generic ?? ""}`.toUpperCase();
  if (/\b(INHALERS?|INHALATION|AEROSOL|DPI|MDI|PRESSURI[SZ]ED)\b/.test(text)) return "Inhaler";
  if (/\b(EYE DROPS?|OPHTHALMIC|OTIC|EAR DROPS?|EYE OINT)/.test(text)) return "Eye / ear";
  if (/\b(NASAL)\b/.test(text)) return "Nasal";
  if (/\b(INFUSIONS?|INTRAVENOUS)\b/.test(text) || /\bIV\b/.test(text)) return "Infusion";
  if (
    /\b(INJECTIONS?|INJECTABLE|LYOPHILI[SZ]ED|POWDER FOR INJECTION|POW INJECTION)\b/.test(text)
  ) {
    return "Injection";
  }
  if (/\b(CREAMS?)\b/.test(text)) return "Cream";
  if (/\b(OINTMENTS?)\b/.test(text)) return "Ointment";
  if (/\b(GELS?)\b/.test(text) && !/\bSOFT\s*GELS?\b/.test(text)) return "Gel";
  if (/\b(SUPPOSITOR)/.test(text)) return "Suppository";
  if (/\b(SYRUPS?)\b/.test(text)) return "Syrup";
  if (/\b(SUSPENSIONS?)\b/.test(text)) return "Suspension";
  if (/\b(SOLUTIONS?|DROPS?|LIQUIDS?|ELIXIRS?|LOTIONS?|EMULSIONS?)\b/.test(text)) {
    return "Solution";
  }
  if (/\b(SACHETS?|GRANULES?|POWDER FOR ORAL|POWDER FOR SUSPENSION|ORAL POWDER)\b/.test(text)) {
    return "Powder / sachet";
  }
  if (/\b(SOFT\s*GELS?|SOFTGELS?|SOFT GELATIN)\b/.test(text)) return "Soft capsule";
  if (/\b(CAPSULES?)\b/.test(text)) return "Capsule";
  // TABLETS / FILM COATED / PROLONGED RELEASE (avoid trailing \b after optional suffix)
  if (
    /\bTABLETS?\b/.test(text) ||
    /\bTABS?\b/.test(text) ||
    /FILM\s*COAT/.test(text) ||
    /PROLONGED\s*RELEASE/.test(text) ||
    /MODIFIED\s*RELEASE/.test(text) ||
    /SUSTAINED\s*RELEASE/.test(text)
  ) {
    return "Tablet";
  }
  if (/\b(PATCHES?|TRANSDERMAL)\b/.test(text)) return "Patch";
  if (/\b(SPRAYS?)\b/.test(text)) return "Spray";
  return "Other";
}

export function inferUnit(dosageGroup: string, packType: string | null): string {
  const pt = (packType ?? "").toUpperCase();
  if (/BOTTLE|JAR|HDPE/.test(pt)) return "BOTTLE";
  if (/VIAL|AMPOULE|AMPULE/.test(pt)) return "VIAL";
  if (/TUBE/.test(pt)) return "TUBE";
  if (/BLISTER|STRIP|ALU/.test(pt)) return "STRIP";
  switch (dosageGroup) {
    case "Injection":
    case "Infusion":
      return "VIAL";
    case "Cream":
    case "Ointment":
    case "Gel":
      return "TUBE";
    case "Syrup":
    case "Solution":
    case "Suspension":
      return "BOTTLE";
    case "Inhaler":
    case "Nasal":
      return "PIECE";
    case "Capsule":
    case "Soft capsule":
    case "Tablet":
      return "STRIP";
    default:
      return "UNIT";
  }
}

export function extractStrength(generic: string | null): string | null {
  if (!generic) return null;
  const matches = [...generic.matchAll(new RegExp(STRENGTH_RE.source, "gi"))];
  if (matches.length === 0) return null;
  // Prefer the last strength token (usually the labelled strength).
  const raw = matches[matches.length - 1]![1]!.replace(/\s+/g, "").toUpperCase();
  return raw.replace(/W\/W/g, "% w/w").replace(/W\/V/g, "% w/v");
}

/**
 * NMRA schedule selling rules (Sri Lanka):
 * I     — grocery / general retail (OTC)
 * II A  — pharmacy OTC only
 * II B  — prescription only
 * II C  — prescription + controlled
 * III   — narcotics / abuse risk (Osusala, short supply)
 */
export function scheduleFlags(schedule: string | null, generic: string | null, brand: string | null) {
  const controlledByName = CONTROLLED_NAME_RE.test(`${generic ?? ""} ${brand ?? ""}`);
  const isControlled =
    schedule === "II C" || schedule === "III" || controlledByName;
  const requiresPrescription =
    schedule === "II B" || schedule === "II C" || schedule === "III" || controlledByName;
  return { isControlled, requiresPrescription };
}

export function looksLikeSpcAgent(agent: string | null, manufacturer: string | null): boolean {
  const text = `${agent ?? ""} ${manufacturer ?? ""}`.toUpperCase();
  return /\b(SPC|STATE\s+PHARMACEUTICAL|OSUSALA)\b/.test(text);
}

function parseRegistrationDate(regDateVal: unknown): Date | null {
  if (regDateVal instanceof Date && !Number.isNaN(regDateVal.getTime())) {
    return new Date(
      Date.UTC(regDateVal.getUTCFullYear(), regDateVal.getUTCMonth(), regDateVal.getUTCDate()),
    );
  }
  if (typeof regDateVal === "string" || typeof regDateVal === "number") {
    const d = new Date(regDateVal);
    if (!Number.isNaN(d.getTime())) {
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    }
  }
  return null;
}

/**
 * Collapse header labels for alias matching.
 * "REG. NO." / "REG.NO." / "Reg No" → "REGNO"; strips BOM/punctuation/spacing.
 */
export function normalizeHeaderKey(key: string): string {
  return String(key)
    .replace(/^\uFEFF/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

const REG_NO_HEADER_TOKENS = new Set([
  "REGNO",
  "REGISTRATIONNO",
  "REGISTRATIONNUMBER",
  "REGNUMBER",
]);

export function isRegNoHeader(key: string): boolean {
  return REG_NO_HEADER_TOKENS.has(normalizeHeaderKey(key));
}

/** Resolve a column from common NMRA / CSV header aliases. */
function cell(
  row: Record<string, unknown>,
  ...keys: string[]
): unknown {
  for (const key of keys) {
    if (row[key] != null && String(row[key]).trim() !== "") return row[key];
  }
  // Case / spacing / punctuation-insensitive fallback (REG. NO. ≡ REG.NO.).
  const normMap = new Map<string, string>();
  for (const k of Object.keys(row)) {
    const n = normalizeHeaderKey(k);
    if (n && !normMap.has(n)) normMap.set(n, k);
  }
  for (const key of keys) {
    const actual = normMap.get(normalizeHeaderKey(key));
    if (actual != null && row[actual] != null && String(row[actual]).trim() !== "") {
      return row[actual];
    }
  }
  return null;
}

function findHeaderRowIndex(matrix: unknown[][]): number {
  const maxScan = Math.min(40, matrix.length);
  for (let i = 0; i < maxScan; i++) {
    const row = matrix[i] ?? [];
    for (const value of row) {
      if (value != null && isRegNoHeader(String(value))) return i;
    }
  }
  return -1;
}

/** Convert a worksheet into row objects, detecting a non-zero header row when needed. */
export function sheetToNmraRecords(sheet: XLSX.WorkSheet): Record<string, unknown>[] {
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: null,
    raw: false,
  });
  if (!matrix.length) return [];

  const headerIdx = findHeaderRowIndex(matrix);
  if (headerIdx < 0) {
    return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null });
  }

  const headers = (matrix[headerIdx] ?? []).map((h, i) => {
    if (h == null || String(h).trim() === "") return `__COL_${i}`;
    return String(h).replace(/^\uFEFF/, "").replace(/\s+/g, " ").trim();
  });

  const records: Record<string, unknown>[] = [];
  for (let r = headerIdx + 1; r < matrix.length; r++) {
    const row = matrix[r] ?? [];
    const obj: Record<string, unknown> = {};
    let any = false;
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c]!;
      const val = row[c] ?? null;
      if (val != null && String(val).trim() !== "") any = true;
      if (obj[key] == null || String(obj[key]).trim() === "") {
        obj[key] = val;
      }
    }
    if (any) records.push(obj);
  }
  return records;
}

/** Prefer the sheet that contains a REG.NO. (or alias) header column. */
export function pickNmraSheet(wb: XLSX.WorkBook): XLSX.WorkSheet {
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    if (!sheet) continue;
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: null,
      raw: false,
    });
    if (findHeaderRowIndex(matrix) >= 0) return sheet;
  }
  const first = wb.Sheets[wb.SheetNames[0]!];
  if (!first) throw new Error("NMRA workbook has no sheets");
  return first;
}

function workbookToNmraRecords(wb: XLSX.WorkBook): Record<string, unknown>[] {
  return sheetToNmraRecords(pickNmraSheet(wb));
}

export type ParseNmraOptions = {
  /** Registration numbers forced inactive (seed demo inactive SKU). */
  inactiveRegs?: Set<string>;
  /** Optional barcode map keyed by registration number. */
  barcodeByRegNo?: Map<string, string>;
};

/**
 * Parse NMRA Valid Registration Excel/CSV rows into normalized product rows.
 * Accepts sheet_to_json records or CSV-parsed objects.
 */
export function parseNmraProductRows(
  raw: Record<string, unknown>[],
  options?: ParseNmraOptions,
): NmraProductRow[] {
  const seenReg = new Map<string, number>();
  const inactiveRegs = options?.inactiveRegs ?? new Set<string>();
  const barcodeByRegNo = options?.barcodeByRegNo;
  const rows: NmraProductRow[] = [];

  for (const r of raw) {
    const registrationNo = clean(
      cell(
        r,
        "REG.NO.",
        "REG. NO.",
        "REG NO",
        "REG NO.",
        "REGNO",
        "REGISTRATION NO",
        "REGISTRATION NO.",
        "REGISTRATION_NO",
        "REGISTRATION NUMBER",
      ),
    );
    if (!registrationNo) continue;

    const seq = (seenReg.get(registrationNo) ?? 0) + 1;
    seenReg.set(registrationNo, seq);
    const sku = seq === 1 ? registrationNo : `${registrationNo}-${seq}`;

    const brandCell = clean(cell(r, "BRAND NAME", "BRAND"));
    const genericRaw = clean(cell(r, "GENERIC NAME", "GENERIC"));
    const dosageRaw = clean(cell(r, "DOSAGE", "DOSAGE FORM", "DOSAGE_FORM"));
    const packSize = clean(cell(r, "PACK SIZE", "PACK_SIZE"));
    const packType = clean(cell(r, "PACK TYPE", "PACK_TYPE"));
    const manufacturer = clean(cell(r, "MANUFACTURE", "MANUFACTURER"));
    const countryOfOrigin = clean(cell(r, "COUNTRY", "COUNTRY OF ORIGIN"));
    const localAgent = clean(cell(r, "AGENT", "LOCAL AGENT"));
    const schedule = normalizeSchedule(clean(cell(r, "SCHEDULE")));
    const regType = clean(
      cell(r, "REG.TYPE", "REG TYPE", "REG_TYPE", "REGI. TYPE", "REGI TYPE", "REGITYPE"),
    );
    const dossierNo = clean(cell(r, "DOSSIER NO.", "DOSSIER NO", "DOSSIER_NO"));
    const registrationDate = parseRegistrationDate(
      cell(r, "REG.DATE", "REG DATE", "REG. DATE", "REG_DATE"),
    );
    const barcodeFromRow = clean(cell(r, "BARCODE", "EAN", "GTIN", "UPC"));
    const barcode =
      barcodeFromRow ??
      barcodeByRegNo?.get(registrationNo) ??
      null;

    const dosageFormGroup = normalizeDosageFormGroup(dosageRaw, genericRaw);
    const genericName = genericRaw ? catalogCaps(genericRaw) : null;
    const dosageForm = dosageRaw ? catalogCaps(dosageRaw) : catalogCaps(dosageFormGroup);
    const strength = extractStrength(genericRaw);

    const codedBrand = brandCell ? isCodedBrandName(brandCell) : false;
    const unbranded = !brandCell;

    let brandName: string | null;
    let name: string;
    if (unbranded) {
      brandName = UNBRANDED_BRAND_LABEL;
      name = genericName ?? "UNNAMED MEDICINE";
    } else if (codedBrand) {
      brandName = catalogCaps(brandCell!);
      name = genericName ?? brandName;
    } else {
      const split = splitBrandAndProductName(brandCell!);
      brandName = split.brandName;
      name = split.productName;
    }

    const flags = scheduleFlags(schedule, genericRaw, brandCell);

    rows.push({
      id: randomUUID(),
      sku,
      name,
      brandName,
      genericName,
      manufacturer: manufacturer ? catalogCaps(manufacturer) : null,
      dosageForm,
      dosageFormGroup,
      strength: strength ? catalogCaps(strength) : null,
      unit: inferUnit(dosageFormGroup, packType),
      packSize: packSize ? catalogCaps(packSize) : null,
      packType: packType ? catalogCaps(packType) : null,
      barcode: barcode ? barcode.replace(/\s+/g, "") : null,
      registrationNo,
      registrationDate,
      schedule,
      scheduleGroup: schedule,
      regType,
      dossierNo,
      countryOfOrigin: countryOfOrigin ? catalogCaps(countryOfOrigin) : null,
      localAgent: localAgent ? catalogCaps(localAgent) : null,
      isControlled: flags.isControlled,
      requiresPrescription: flags.requiresPrescription,
      isUnbranded: unbranded,
      isActive: !inactiveRegs.has(registrationNo),
      reorderLevel: 0,
    });
  }

  return rows;
}

/** Load NMRA products from an Excel/CSV buffer (upload path). */
export function loadNmraProductsFromBuffer(
  buffer: Buffer,
  options?: ParseNmraOptions & { filename?: string },
): NmraProductRow[] {
  const name = (options?.filename ?? "").toLowerCase();
  const wb = name.endsWith(".csv")
    ? XLSX.read(buffer, { type: "buffer", raw: false, cellDates: true })
    : XLSX.read(buffer, { type: "buffer", cellDates: true });
  if (!wb.SheetNames.length) throw new Error("NMRA workbook has no sheets");
  const raw = workbookToNmraRecords(wb);
  return parseNmraProductRows(raw, options);
}

/** Load NMRA products from an Excel file path (seed path). */
export function loadNmraProductsFromExcel(
  filePath: string,
  options?: ParseNmraOptions,
): NmraProductRow[] {
  const wb = XLSX.readFile(filePath, { cellDates: true });
  if (!wb.SheetNames.length) throw new Error("NMRA workbook has no sheets");
  const raw = workbookToNmraRecords(wb);
  return parseNmraProductRows(raw, options);
}

/**
 * Pick a diverse set of registration numbers for demo stock across schedules/forms.
 * Always includes DEMO_STOCK_REG_NOS values that exist in the catalog.
 */
export function selectDemoStockRegistrationNos(
  products: NmraProductRow[],
  target = EXPANDED_DEMO_STOCK_TARGET,
): string[] {
  const byReg = new Map<string, NmraProductRow>();
  for (const p of products) {
    if (!p.isActive) continue;
    if (!byReg.has(p.registrationNo)) byReg.set(p.registrationNo, p);
  }

  const selected = new Set<string>();
  for (const reg of Object.values(DEMO_STOCK_REG_NOS)) {
    if (byReg.has(reg)) selected.add(reg);
  }

  const schedules = ["I", "II A", "II B", "II C", "III"];
  const formGroups = [
    "Tablet",
    "Capsule",
    "Injection",
    "Syrup",
    "Cream",
    "Suspension",
    "Solution",
    "Inhaler",
    "Soft capsule",
    "Powder / sachet",
    "Eye / ear",
    "Other",
  ];

  // Round-robin across schedule × form for diversity.
  const buckets = new Map<string, NmraProductRow[]>();
  for (const p of byReg.values()) {
    if (selected.has(p.registrationNo)) continue;
    const key = `${p.scheduleGroup ?? "?"}::${p.dosageFormGroup}`;
    const list = buckets.get(key) ?? [];
    list.push(p);
    buckets.set(key, list);
  }

  let progressed = true;
  while (selected.size < target && progressed) {
    progressed = false;
    for (const schedule of schedules) {
      for (const form of formGroups) {
        if (selected.size >= target) break;
        const list = buckets.get(`${schedule}::${form}`);
        if (!list?.length) continue;
        const next = list.shift()!;
        selected.add(next.registrationNo);
        progressed = true;
      }
    }
    // Drain remaining buckets if schedule/form combos exhausted early.
    if (!progressed) {
      for (const list of buckets.values()) {
        while (list.length && selected.size < target) {
          selected.add(list.shift()!.registrationNo);
          progressed = true;
        }
        if (selected.size >= target) break;
      }
    }
  }

  return [...selected];
}

/** Default reorder level for expanded demo SKUs. */
export function demoReorderLevelForIndex(index: number): number {
  const levels = [5, 8, 10, 12, 15, 20, 25, 30];
  return levels[index % levels.length]!;
}

/**
 * Plausible LKR cost/sell by NMRA schedule + form (OTC cheaper, Rx mid, controlled higher).
 * Falls back to index-only pricing when schedule is unknown.
 */
export function demoPricingForProduct(
  meta: {
    schedule?: string | null;
    isControlled?: boolean | null;
    dosageFormGroup?: string | null;
  },
  index: number,
): { qty: number; cost: number; sell: number } {
  const sched = (meta.schedule ?? "").replace(/\s+/g, " ").trim().toUpperCase();
  let baseCost: number;
  if (sched === "I" || sched === "1") {
    baseCost = 18 + (index % 55);
  } else if (sched === "II A" || sched === "IIA" || sched === "2A") {
    baseCost = 40 + (index % 90);
  } else if (sched === "II B" || sched === "IIB" || sched === "2B") {
    baseCost = 70 + (index % 160);
  } else if (
    sched === "II C" ||
    sched === "IIC" ||
    sched === "2C" ||
    meta.isControlled
  ) {
    baseCost = 140 + (index % 420);
  } else if (sched === "III" || sched === "3") {
    baseCost = 220 + (index % 580);
  } else {
    baseCost = 35 + ((index * 13) % 180);
  }

  const form = (meta.dosageFormGroup ?? "").toLowerCase();
  if (form.includes("injection")) baseCost = Math.round(baseCost * 1.45);
  else if (form.includes("inhaler")) baseCost = Math.round(baseCost * 1.25);
  else if (form.includes("syrup") || form.includes("suspension")) {
    baseCost = Math.round(baseCost * 1.1);
  }

  const margin = meta.isControlled
    ? 1.4 + (index % 4) * 0.05
    : 1.28 + (index % 5) * 0.06;
  const sell = Math.max(baseCost + 5, Math.round(baseCost * margin));
  const qty = 35 + ((index * 17) % 180);
  return { qty, cost: baseCost, sell };
}

/** Deterministic demo qty/cost/sell for a registration index (schedule-agnostic fallback). */
export function demoStockLineForIndex(index: number): {
  qty: number;
  cost: number;
  sell: number;
} {
  return demoPricingForProduct({}, index);
}
