import {
  CatalogIndex,
  needsComplianceConfirmation,
  normalizeName,
  type MatchCandidate,
} from "./product-import-match";

function candidate(partial: Partial<MatchCandidate> = {}): MatchCandidate {
  return {
    id: "p1",
    name: "PARACETAMOL TABLETS BP 500MG",
    barcode: null,
    registrationNo: null,
    genericName: "PARACETAMOL",
    strength: "500MG",
    dosageForm: "TABLET",
    isControlled: false,
    requiresPrescription: false,
    ...partial,
  };
}

function row(partial: Partial<Parameters<CatalogIndex["match"]>[0]> = {}) {
  return {
    name: "Paracetamol Tablets BP 500mg",
    barcode: null,
    registrationNo: null,
    genericName: null,
    strength: null,
    dosageForm: null,
    ...partial,
  };
}

describe("product import — name normalisation", () => {
  it("folds the dosage-form abbreviations every system spells differently", () => {
    expect(normalizeName("PARACETAMOL TAB 500MG")).toBe(
      normalizeName("Paracetamol Tablet 500 mg"),
    );
    expect(normalizeName("AMOXICILLIN CAPS 250MG")).toBe(
      normalizeName("Amoxicillin Capsule 250mg"),
    );
  });

  it("treats a spaced unit and a joined unit as the same strength", () => {
    expect(normalizeName("Ibuprofen 400 mg")).toBe(normalizeName("Ibuprofen 400mg"));
  });

  it("does not fold two genuinely different products together", () => {
    expect(normalizeName("Paracetamol 500mg")).not.toBe(
      normalizeName("Paracetamol 250mg"),
    );
  });
});

describe("product import — matching cascade", () => {
  it("prefers a barcode match over everything else", () => {
    const index = new CatalogIndex([
      candidate({ id: "by-barcode", barcode: "4892345001234", name: "SOMETHING ELSE" }),
      candidate({ id: "by-name" }),
    ]);

    const result = index.match(row({ barcode: "4892345001234" }));

    expect(result?.candidate.id).toBe("by-barcode");
    expect(result?.confidence).toBe("barcode");
  });

  it("falls to registration number, then exact name, then normalised name", () => {
    const byReg = new CatalogIndex([candidate({ id: "reg", registrationNo: "M011664" })]);
    expect(byReg.match(row({ registrationNo: "M011664" }))?.confidence).toBe("registration");

    const byExact = new CatalogIndex([candidate({ id: "exact", name: "Panadol" })]);
    expect(byExact.match(row({ name: "panadol" }))?.confidence).toBe("name");

    const byNorm = new CatalogIndex([
      candidate({ id: "norm", name: "PARACETAMOL TABLETS 500MG" }),
    ]);
    expect(byNorm.match(row({ name: "Paracetamol Tab 500 mg" }))?.confidence).toBe(
      "normalized",
    );
  });

  it("matches on generic + strength + form when the name is unrecognisable", () => {
    const index = new CatalogIndex([candidate({ id: "clinical" })]);

    const result = index.match(
      row({
        name: "Some House Brand 500",
        genericName: "Paracetamol",
        strength: "500 mg",
        dosageForm: "Tablets",
      }),
    );

    expect(result?.candidate.id).toBe("clinical");
    expect(result?.confidence).toBe("fuzzy");
  });

  it("refuses to guess when a tier is ambiguous", () => {
    // Two registrations of the same molecule — linking to either would be a coin flip, and the
    // wrong one carries the wrong registration number into the pharmacy's catalog.
    const index = new CatalogIndex([
      candidate({ id: "a", name: "PARACETAMOL 500", registrationNo: "M0001" }),
      candidate({ id: "b", name: "PARACETAMOL 500", registrationNo: "M0002" }),
    ]);

    const result = index.match(
      row({
        name: "Nothing like it",
        genericName: "Paracetamol",
        strength: "500mg",
        dosageForm: "Tablet",
      }),
    );

    expect(result).toBeNull();
  });

  it("returns null when nothing matches, so the row becomes a new retail product", () => {
    const index = new CatalogIndex([candidate()]);
    expect(index.match(row({ name: "Sunsilk Shampoo 180ml" }))).toBeNull();
  });
});

describe("product import — compliance confirmation", () => {
  it("holds a fuzzy match that would mark a product controlled", () => {
    const outcome = {
      candidate: candidate({ isControlled: true }),
      confidence: "fuzzy" as const,
    };
    expect(needsComplianceConfirmation(outcome)).toBe(true);
  });

  it("holds a fuzzy match that would make a product prescription-only", () => {
    const outcome = {
      candidate: candidate({ requiresPrescription: true }),
      confidence: "fuzzy" as const,
    };
    expect(needsComplianceConfirmation(outcome)).toBe(true);
  });

  it("trusts exact evidence even for a controlled product", () => {
    // A barcode or registration number is the product's identity, not a guess about it —
    // asking a pharmacy to confirm 2,000 of those would make the importer unusable.
    for (const confidence of ["barcode", "registration", "name", "normalized"] as const) {
      expect(
        needsComplianceConfirmation({
          candidate: candidate({ isControlled: true, requiresPrescription: true }),
          confidence,
        }),
      ).toBe(false);
    }
  });

  it("lets an ordinary fuzzy match through — only compliance flags need confirming", () => {
    expect(
      needsComplianceConfirmation({ candidate: candidate(), confidence: "fuzzy" }),
    ).toBe(false);
  });
});
