import { buildNmraLinkPlan, type NmraLinkableFields } from "./product-nmra-link.util";

function fields(partial: Partial<NmraLinkableFields> = {}): NmraLinkableFields {
  return {
    name: "Panadol 500mg Tablet",
    brandName: "Panadol",
    barcode: "4892345001234",
    genericName: "Paracetamol",
    dosageForm: "Tablet",
    strength: "500mg",
    unit: null,
    packSize: null,
    packType: null,
    manufacturer: null,
    localAgent: null,
    countryOfOrigin: null,
    storage: null,
    shelfLife: null,
    registrationNo: null,
    registrationDate: null,
    schedule: null,
    regType: null,
    dossierNo: null,
    isControlled: false,
    requiresPrescription: false,
    ...partial,
  };
}

function reference(partial: Partial<NmraLinkableFields> = {}): NmraLinkableFields {
  return fields({
    name: "PARACETAMOL TABLETS BP 500MG",
    brandName: "GSK Paracetamol",
    barcode: null,
    genericName: "PARACETAMOL TABLETS BP 500MG",
    dosageForm: "TABLET",
    strength: "500MG",
    manufacturer: "GSK Pharmaceuticals",
    packSize: "10x10",
    registrationNo: "M001234",
    registrationDate: new Date("2022-01-15"),
    schedule: "II A",
    regType: "Full",
    dossierNo: "D-4421",
    ...partial,
  });
}

describe("buildNmraLinkPlan — register-always fields", () => {
  it("takes the register's name and keeps the shop's own as a shop_name alias", () => {
    const plan = buildNmraLinkPlan(fields(), reference());

    expect(plan.updates.name).toBe("PARACETAMOL TABLETS BP 500MG");
    expect(plan.aliasesToAdd).toContainEqual({
      aliasText: "Panadol 500mg Tablet",
      aliasType: "shop_name",
    });
  });

  it("takes the register's brand and keeps the shop's own as a shop_brand alias", () => {
    const plan = buildNmraLinkPlan(fields(), reference());

    expect(plan.updates.brandName).toBe("GSK Paracetamol");
    expect(plan.aliasesToAdd).toContainEqual({ aliasText: "Panadol", aliasType: "shop_brand" });
  });

  it("does not alias a name/brand that already matches, even case-insensitively", () => {
    const plan = buildNmraLinkPlan(
      fields({ name: "paracetamol tablets bp 500mg", brandName: "GSK Paracetamol" }),
      reference(),
    );
    expect(plan.aliasesToAdd.some((a) => a.aliasType === "shop_name")).toBe(false);
    expect(plan.aliasesToAdd.some((a) => a.aliasType === "shop_brand")).toBe(false);
  });

  it("takes registrationNo, registrationDate, schedule, regType and dossierNo unconditionally", () => {
    const plan = buildNmraLinkPlan(fields(), reference());
    expect(plan.updates.registrationNo).toBe("M001234");
    expect(plan.updates.registrationDate).toEqual(new Date("2022-01-15"));
    expect(plan.updates.schedule).toBe("II A");
    expect(plan.updates.regType).toBe("Full");
    expect(plan.updates.dossierNo).toBe("D-4421");
  });
});

describe("buildNmraLinkPlan — barcode: shop wins, never overwritten", () => {
  it("never writes the shop's barcode, even though the register carries none here", () => {
    const plan = buildNmraLinkPlan(fields({ barcode: "SHOP-BARCODE" }), reference({ barcode: null }));
    expect(plan.updates.barcode).toBeUndefined();
    const barcodeChange = plan.changes.find((c) => c.field === "barcode")!;
    expect(barcodeChange.changed).toBe(false);
  });

  it("adds a differing register barcode as an alias instead of discarding it", () => {
    const plan = buildNmraLinkPlan(
      fields({ barcode: "SHOP-BARCODE" }),
      reference({ barcode: "REGISTER-BARCODE" }),
    );
    expect(plan.updates.barcode).toBeUndefined();
    expect(plan.aliasesToAdd).toContainEqual({
      aliasText: "REGISTER-BARCODE",
      aliasType: "barcode",
    });
  });

  it("adds no barcode alias when the register's matches the shop's", () => {
    const plan = buildNmraLinkPlan(
      fields({ barcode: "SAME" }),
      reference({ barcode: "SAME" }),
    );
    expect(plan.aliasesToAdd.some((a) => a.aliasType === "barcode")).toBe(false);
  });
});

describe("buildNmraLinkPlan — compliance flags: register wins, stated in words", () => {
  it("states in words when a product becomes controlled", () => {
    const plan = buildNmraLinkPlan(
      fields({ isControlled: false }),
      reference({ isControlled: true }),
    );
    expect(plan.updates.isControlled).toBe(true);
    expect(plan.complianceStatements).toContain(
      "This becomes a controlled medicine, requiring pharmacist dispense authority.",
    );
  });

  it("states in words when a product becomes prescription-only", () => {
    const plan = buildNmraLinkPlan(
      fields({ requiresPrescription: false }),
      reference({ requiresPrescription: true }),
    );
    expect(plan.updates.requiresPrescription).toBe(true);
    expect(plan.complianceStatements).toContain("This becomes a prescription-only product.");
  });

  it("says nothing when neither compliance flag changes", () => {
    const plan = buildNmraLinkPlan(fields(), reference());
    expect(plan.complianceStatements).toEqual([]);
  });

  it("is not overridable — no opt-out for a compliance-flag change", () => {
    const plan = buildNmraLinkPlan(
      fields({ isControlled: false }),
      reference({ isControlled: true }),
      { adoptFieldOverrides: ["isControlled"] },
    );
    expect(plan.updates.isControlled).toBe(true);
  });
});

describe("buildNmraLinkPlan — fill-if-empty fields", () => {
  it("adopts the register's value when the shop's own is empty", () => {
    const plan = buildNmraLinkPlan(fields({ manufacturer: null }), reference());
    expect(plan.updates.manufacturer).toBe("GSK Pharmaceuticals");
  });

  it("keeps the shop's own value by default when it already has one", () => {
    const plan = buildNmraLinkPlan(
      fields({ manufacturer: "Shop's own supplier note" }),
      reference(),
    );
    expect(plan.updates.manufacturer).toBeUndefined();
    const change = plan.changes.find((c) => c.field === "manufacturer")!;
    expect(change.changed).toBe(false);
    expect(change.adoptable).toBe(true);
  });

  it("force-adopts an already-populated field only when explicitly overridden", () => {
    const plan = buildNmraLinkPlan(
      fields({ manufacturer: "Shop's own supplier note" }),
      reference(),
      { adoptFieldOverrides: ["manufacturer"] },
    );
    expect(plan.updates.manufacturer).toBe("GSK Pharmaceuticals");
  });

  it("treats an empty string the same as null", () => {
    const plan = buildNmraLinkPlan(fields({ packSize: "" }), reference());
    expect(plan.updates.packSize).toBe("10x10");
  });
});

describe("buildNmraLinkPlan — untouched fields", () => {
  it("never mentions sku, reorderLevel, pricing, batches or stock", () => {
    const plan = buildNmraLinkPlan(fields(), reference());
    const fieldNames = plan.changes.map((c) => c.field);
    for (const untouched of ["sku", "reorderLevel"]) {
      expect(fieldNames).not.toContain(untouched);
    }
  });
});
