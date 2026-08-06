import {
  SCHEDULE_LABELS,
  UNBRANDED_BRAND_LABEL,
  looksLikeSpcAgent,
  type NmraProductRow,
} from "./nmra-normalize";

/**
 * NMRA upsert merge policy (tenant-scoped by registrationNo):
 *
 * UPDATE from file: NMRA catalog scalars only (name, brand, generic, manufacturer,
 * dosage/strength/pack, schedule, regType, dossier, origin, agent, controlled/Rx flags,
 * isActive, registrationDate). Optionally barcode when present and not conflicting.
 *
 * PRESERVE on existing products: sku, manually added tags, aliases, category maps,
 * and any non-NMRA fields (taxCategory, reorderLevel, image, storage, etc.).
 *
 * MERGE relations: add missing NMRA-derived schedule/form tags and category maps;
 * never delete user-only tags/aliases/categories. Aliases from the file are added
 * with skipDuplicates; existing user synonyms stay.
 */

export type NmraMutableFields = {
  name: string;
  brandName: string | null;
  genericName: string | null;
  manufacturer: string | null;
  dosageForm: string | null;
  strength: string | null;
  unit: string | null;
  packSize: string | null;
  packType: string | null;
  registrationDate: Date | null;
  schedule: string | null;
  regType: string | null;
  dossierNo: string | null;
  countryOfOrigin: string | null;
  localAgent: string | null;
  isControlled: boolean;
  requiresPrescription: boolean;
  isActive: boolean;
  barcode?: string | null;
};

export type ExistingForNmraUpsert = {
  id: string;
  registrationNo: string | null;
  sku: string;
  barcode: string | null;
};

/** NMRA scalar fields applied on create/update. Does not include sku. */
export function buildNmraMutableFields(
  row: NmraProductRow,
  existing: Pick<ExistingForNmraUpsert, "barcode"> | null,
  opts?: { barcodeOwnedByOther?: boolean },
): NmraMutableFields {
  const base: NmraMutableFields = {
    name: row.name,
    brandName: row.brandName,
    genericName: row.genericName,
    manufacturer: row.manufacturer,
    dosageForm: row.dosageForm,
    strength: row.strength,
    unit: row.unit,
    packSize: row.packSize,
    packType: row.packType,
    registrationDate: row.registrationDate,
    schedule: row.schedule,
    regType: row.regType,
    dossierNo: row.dossierNo,
    countryOfOrigin: row.countryOfOrigin,
    localAgent: row.localAgent,
    isControlled: row.isControlled,
    requiresPrescription: row.requiresPrescription,
    isActive: row.isActive,
  };

  // Barcode: set from file only when present and not conflicting; never wipe an existing one.
  if (row.barcode) {
    if (!opts?.barcodeOwnedByOther) {
      base.barcode = row.barcode;
    }
    // Conflicting barcode: omit so update preserves existing; create uses explicit null.
  } else if (!existing) {
    base.barcode = null;
  }

  return base;
}

export const NMRA_TAG_DEFS: Array<{
  name: string;
  pred: (p: NmraProductRow) => boolean;
}> = [
  { name: "NMRA registered", pred: () => true },
  {
    name: "Unbranded",
    pred: (p) => p.isUnbranded || p.brandName === UNBRANDED_BRAND_LABEL,
  },
  {
    name: "SPC / state supply",
    pred: (p) => looksLikeSpcAgent(p.localAgent, p.manufacturer),
  },
  { name: "Grocery / Schedule I", pred: (p) => p.schedule === "I" },
  { name: "Pharmacy OTC / Schedule II A", pred: (p) => p.schedule === "II A" },
  { name: "Prescription / Schedule II B", pred: (p) => p.schedule === "II B" },
  { name: "Controlled Rx / Schedule II C", pred: (p) => p.schedule === "II C" },
  { name: "Narcotic / Schedule III (Osusala)", pred: (p) => p.schedule === "III" },
  { name: "Prescription required", pred: (p) => p.requiresPrescription },
  { name: "Controlled medicine", pred: (p) => p.isControlled },
];

/** Tag names that should be linked for this NMRA row (merge-add only). */
export function nmraDerivedTagNames(row: NmraProductRow): string[] {
  return NMRA_TAG_DEFS.filter((t) => t.pred(row)).map((t) => t.name);
}

export type NmraCategoryKey = {
  parent: "Dosage form" | "NMRA Schedule" | "Registration type";
  name: string;
};

/** Category children to ensure + map for this row (merge-add only). */
export function nmraCategoryKeysForRow(row: NmraProductRow): NmraCategoryKey[] {
  const keys: NmraCategoryKey[] = [
    { parent: "Dosage form", name: row.dosageFormGroup },
  ];
  if (row.scheduleGroup) {
    keys.push({
      parent: "NMRA Schedule",
      name: SCHEDULE_LABELS[row.scheduleGroup] ?? `Schedule ${row.scheduleGroup}`,
    });
  }
  if (row.regType) {
    keys.push({ parent: "Registration type", name: row.regType });
  }
  return keys;
}

export type NmraAliasDraft = {
  aliasText: string;
  aliasType: string;
};

/** NMRA-sourced aliases to merge-add (never removes user aliases). */
export function nmraAliasDraftsForRow(row: NmraProductRow): NmraAliasDraft[] {
  const aliases: NmraAliasDraft[] = [
    { aliasText: row.registrationNo, aliasType: "registration_no" },
  ];
  if (row.dossierNo && row.dossierNo !== row.registrationNo) {
    aliases.push({ aliasText: row.dossierNo, aliasType: "dossier_no" });
  }
  if (row.brandName && row.brandName.toLowerCase() !== row.name.toLowerCase()) {
    aliases.push({ aliasText: row.brandName, aliasType: "brand" });
  }
  if (row.barcode) {
    aliases.push({ aliasText: row.barcode, aliasType: "barcode" });
  }
  return aliases;
}

export function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error("chunk size must be > 0");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
