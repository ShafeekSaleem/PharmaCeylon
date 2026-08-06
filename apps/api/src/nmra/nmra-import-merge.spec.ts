import {
  buildNmraMutableFields,
  chunkArray,
  nmraAliasDraftsForRow,
  nmraCategoryKeysForRow,
  nmraDerivedTagNames,
} from "./nmra-import-merge";
import type { NmraProductRow } from "./nmra-normalize";

function row(partial: Partial<NmraProductRow> = {}): NmraProductRow {
  return {
    id: "id-1",
    sku: "SKU-1",
    name: "TEST PRODUCT",
    brandName: null,
    genericName: null,
    manufacturer: null,
    dosageForm: "TABLET",
    dosageFormGroup: "Oral solid",
    strength: null,
    unit: null,
    packSize: null,
    packType: null,
    barcode: null,
    registrationNo: "M000001",
    registrationDate: null,
    schedule: "II B",
    scheduleGroup: "II B",
    regType: "NEW",
    dossierNo: null,
    countryOfOrigin: null,
    localAgent: null,
    isControlled: false,
    requiresPrescription: true,
    isUnbranded: false,
    isActive: true,
    reorderLevel: 0,
    ...partial,
  };
}

describe("NMRA import merge policy", () => {
  it("updates NMRA scalars but does not include sku", () => {
    const fields = buildNmraMutableFields(
      row({ name: "PARACETAMOL 500MG", brandName: "PANADOL" }),
      { barcode: "111" },
    );
    expect(fields.name).toBe("PARACETAMOL 500MG");
    expect(fields.brandName).toBe("PANADOL");
    expect(fields).not.toHaveProperty("sku");
    // Existing barcode preserved when file has none
    expect(fields.barcode).toBeUndefined();
  });

  it("sets barcode from file when not conflicting", () => {
    const fields = buildNmraMutableFields(
      row({ name: "X", barcode: "999" }),
      { barcode: "111" },
      { barcodeOwnedByOther: false },
    );
    expect(fields.barcode).toBe("999");
  });

  it("skips barcode when owned by another product", () => {
    const fields = buildNmraMutableFields(
      row({ name: "X", barcode: "999" }),
      { barcode: "111" },
      { barcodeOwnedByOther: true },
    );
    expect(fields.barcode).toBeUndefined();
  });

  it("does not apply conflicting barcode on create either", () => {
    const fields = buildNmraMutableFields(
      row({ name: "X", barcode: "999" }),
      null,
      { barcodeOwnedByOther: true },
    );
    expect(fields.barcode).toBeUndefined();
  });

  it("merges schedule/Rx tags without implying wipe of user tags", () => {
    const tags = nmraDerivedTagNames(
      row({
        name: "MORPHINE",
        schedule: "III",
        scheduleGroup: "III",
        isControlled: true,
        requiresPrescription: true,
      }),
    );
    expect(tags).toEqual(
      expect.arrayContaining([
        "NMRA registered",
        "Narcotic / Schedule III (Osusala)",
        "Prescription required",
        "Controlled medicine",
      ]),
    );
    expect(tags).not.toContain("Grocery / Schedule I");
  });

  it("builds category keys for dosage/schedule/reg type (merge-add)", () => {
    const keys = nmraCategoryKeysForRow(
      row({ name: "X", dosageFormGroup: "Oral solid", scheduleGroup: "II A", regType: "RENEWAL" }),
    );
    expect(keys.map((k) => k.parent)).toEqual([
      "Dosage form",
      "NMRA Schedule",
      "Registration type",
    ]);
    expect(keys[1]!.name).toContain("II A");
  });

  it("drafts aliases without replacing user synonyms", () => {
    const aliases = nmraAliasDraftsForRow(
      row({
        name: "PARACETAMOL",
        registrationNo: "M001",
        brandName: "PANADOL",
        barcode: "123",
        dossierNo: "D001",
      }),
    );
    expect(aliases.map((a) => a.aliasType)).toEqual([
      "registration_no",
      "dossier_no",
      "brand",
      "barcode",
    ]);
  });

  it("chunks sequentially without overlap", () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});
