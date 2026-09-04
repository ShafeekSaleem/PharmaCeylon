import {
  CatalogIndex,
  innHead,
  needsComplianceConfirmation,
  normalizeName,
  rankedCandidateNeedsComplianceConfirmation,
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
    brandName: null,
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

// Fixtures sampled from the real Sri Lankan NMRA register (see F5 in the plan) — the register's
// genericName is a full monograph title, not an INN.
describe("innHead — extracting the substance name from a monograph title", () => {
  it("strips the dosage form and pharmacopoeia standard, real register samples", () => {
    expect(innHead("SITAGLIPTIN TABLETS BP 100MG")).toBe("sitagliptin");
    expect(innHead("PARACETAMOL TABLETS BP 500MG")).toBe("paracetamol");
    expect(innHead("ALPRAZOLAM TABLETS USP 0.25MG")).toBe("alprazolam");
    expect(innHead("DOMPERIDONE TABLETS BP 10MG")).toBe("domperidone");
    expect(innHead("CLOTRIMAZOLE CREAM USP 1% W/W")).toBe("clotrimazole");
  });

  it("keeps a combination product's full name — that IS the substance name", () => {
    expect(innHead("PARACETAMOL AND CAFFEINE TABLETS BP")).toBe("paracetamol and caffeine");
  });

  it("meets a shop's plain generic name once the monograph tail is stripped", () => {
    expect(innHead("PARACETAMOL TABLETS BP 500MG")).toBe(innHead("Paracetamol"));
  });

  it("returns empty for a blank or missing generic name", () => {
    expect(innHead(null)).toBe("");
    expect(innHead("")).toBe("");
  });

  // Known-bad case, pinned rather than hidden: a salt suffix (sulphate, hydrochloride, …) is
  // not a dosage form or pharmacopoeia word, so the naive rule leaves it in the head. That
  // means "Salbutamol Sulphate Tablets BP" still won't meet a shop's plain "Salbutamol" — a
  // real gap. Stripping salts safely (without also eating real generic names that end the
  // same way) is follow-up work, not attempted by this tier.
  it("does not strip a salt suffix — known gap, not a silent success", () => {
    expect(innHead("SALBUTAMOL SULPHATE TABLETS BP 4MG")).toBe("salbutamol sulphate");
    expect(innHead("SALBUTAMOL SULPHATE TABLETS BP 4MG")).not.toBe(innHead("Salbutamol"));
  });
});

describe("CatalogIndex.rankedCandidates", () => {
  it("surfaces every registered brand of the same INN, ranked, not a unique pick", () => {
    // The F5 acceptance scenario: a shop's "Panadol 500mg Tablet" (genericName filled in as
    // plain "Paracetamol") against a register carrying several differently-branded
    // paracetamol 500mg tablets, none of which share the shop's exact or normalized name.
    const index = new CatalogIndex([
      candidate({ id: "panadol-reg", name: "PARACETAMOL TABLETS BP 500MG", brandName: "Panadol" }),
      candidate({ id: "calpol-reg", name: "PARACETAMOL TABLETS BP 500MG", brandName: "Calpol" }),
      candidate({ id: "unrelated", genericName: "IBUPROFEN", name: "IBUPROFEN TABLETS BP 400MG" }),
    ]);

    const ranked = index.rankedCandidates({
      name: "Panadol 500mg Tablet",
      barcode: null,
      registrationNo: null,
      genericName: "Paracetamol",
      strength: "500mg",
      dosageForm: "Tablet",
    });

    const ids = ranked.map((r) => r.candidate.id);
    expect(ids).toContain("panadol-reg");
    expect(ids).toContain("calpol-reg");
    expect(ids).not.toContain("unrelated");
    // Both paracetamol candidates arrive via the clinical-key tier (generic+strength+form all
    // match) before the INN-head tier ever needs to fire for this row.
    expect(ranked.every((r) => r.evidence === "fuzzy")).toBe(true);
  });

  it("reaches a match the unique-hit cascade can't, via the INN-head tier alone", () => {
    // Strength differs (500mg shop vs 650mg register), so neither the exact/normalized name
    // nor the clinical-key tier fires — only INN-head, matching on the substance alone.
    const index = new CatalogIndex([
      candidate({ id: "reg-650", name: "PARACETAMOL TABLETS BP 650MG", strength: "650MG" }),
    ]);

    expect(
      index.match({
        name: "Panadol 500mg Tablet",
        barcode: null,
        registrationNo: null,
        genericName: "Paracetamol",
        strength: "500mg",
        dosageForm: "Tablet",
      }),
    ).toBeNull();

    const ranked = index.rankedCandidates({
      name: "Panadol 500mg Tablet",
      barcode: null,
      registrationNo: null,
      genericName: "Paracetamol",
      strength: "500mg",
      dosageForm: "Tablet",
    });
    expect(ranked).toEqual([{ candidate: expect.objectContaining({ id: "reg-650" }), evidence: "inn_head" }]);
  });

  it("keeps a candidate's strongest evidence when more than one tier would find it", () => {
    const index = new CatalogIndex([candidate({ id: "only" })]);
    const ranked = index.rankedCandidates({
      name: candidate().name,
      barcode: null,
      registrationNo: null,
      genericName: "PARACETAMOL",
      strength: "500MG",
      dosageForm: "TABLET",
    });
    expect(ranked).toHaveLength(1);
    expect(ranked[0].evidence).toBe("name");
  });

  it("caps the result at `take`", () => {
    const index = new CatalogIndex(
      Array.from({ length: 30 }, (_, i) => candidate({ id: `p${i}` })),
    );
    expect(index.rankedCandidates(candidate(), 5)).toHaveLength(5);
  });
});

describe("rankedCandidateNeedsComplianceConfirmation", () => {
  it("trusts exact evidence even for a controlled, prescription product", () => {
    for (const evidence of ["barcode", "registration", "name"] as const) {
      expect(
        rankedCandidateNeedsComplianceConfirmation({
          candidate: candidate({ isControlled: true, requiresPrescription: true }),
          evidence,
        }),
      ).toBe(false);
    }
  });

  it("holds weaker evidence — normalized, fuzzy, or INN-head — when it would change a compliance flag", () => {
    for (const evidence of ["normalized", "fuzzy", "inn_head"] as const) {
      expect(
        rankedCandidateNeedsComplianceConfirmation({
          candidate: candidate({ isControlled: true }),
          evidence,
        }),
      ).toBe(true);
    }
  });

  it("lets weak evidence through when nothing compliance-related would change", () => {
    expect(
      rankedCandidateNeedsComplianceConfirmation({ candidate: candidate(), evidence: "inn_head" }),
    ).toBe(false);
  });
});
