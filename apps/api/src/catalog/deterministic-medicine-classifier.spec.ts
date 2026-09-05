import { classifyMedicine } from "./deterministic-medicine-classifier";

describe("classifyMedicine — medicines", () => {
  it("reads the generic name first, at the highest confidence", () => {
    expect(classifyMedicine("METFORMIN HYDROCHLORIDE", "Glucophage 500mg", "TABLET")).toEqual({
      canonicalKey: "MEDICINES_DIABETES_CARE",
      confidence: 0.85,
    });
  });

  it("falls back to the display name when the generic name is missing, at a lower confidence", () => {
    expect(classifyMedicine(null, "Amoxicillin 250mg Capsule", "CAPSULE")).toEqual({
      canonicalKey: "MEDICINES_ANTI_INFECTIVES",
      confidence: 0.6,
    });
  });

  it("reads the dosage form only when no keyword matched at all", () => {
    expect(classifyMedicine(null, "Barrier Balm", "CREAM")).toEqual({
      canonicalKey: "MEDICINES_DERMATOLOGY",
      confidence: 0.5,
    });
  });

  it("returns null rather than guessing", () => {
    expect(classifyMedicine(null, "Unknown item", null)).toBeNull();
    expect(classifyMedicine(null, null, null)).toBeNull();
  });
});

describe("classifyMedicine — retail goods", () => {
  it("classifies a product that has no generic name for the medicine rules to read", () => {
    expect(classifyMedicine(null, "Signal Cavity Fighter Toothpaste 120g", null)).toEqual({
      canonicalKey: "PERSONAL_CARE_ORAL_CARE",
      confidence: 0.7,
    });
  });

  /**
   * Found by running the classifier over a real seeded register. A register row is titled by
   * its brand and carries the substance in `genericName`, so a rule that read only name and
   * brand could never see "VITAMIN C" — and every vitamin in the catalog fell through to
   * Unclassified.
   */
  it("reads the generic name, which is where a register row keeps the substance", () => {
    expect(
      classifyMedicine("VITAMIN C CHEWABLE TABLETS 500MG", "CEE STRAWBERRY", "Tablet", "CEE"),
    ).toEqual({ canonicalKey: "VITAMINS_SUPPLEMENTS_VITAMINS", confidence: 0.7 });
  });

  it("reads the brand name too, where an import sometimes puts the product type", () => {
    expect(classifyMedicine(null, "Sensodyne 75g", null, "Sensodyne Toothpaste")).toEqual({
      canonicalKey: "PERSONAL_CARE_ORAL_CARE",
      confidence: 0.7,
    });
  });

  it("leaves a medicated product with the medicine rule that matched it first", () => {
    // Retail rules run after every medicine rule, so a ketoconazole shampoo is a medicine.
    expect(
      classifyMedicine("KETOCONAZOLE", "Nizoral Anti-Dandruff Shampoo", null),
    ).toEqual({ canonicalKey: "MEDICINES_ANTI_INFECTIVES", confidence: 0.85 });
  });

  it("beats the dosage-form hint, which is the weakest signal", () => {
    expect(classifyMedicine(null, "Baby Lotion 200ml", "LOTION")).toEqual({
      canonicalKey: "BABY_CARE_BABY_SKIN_CARE",
      confidence: 0.7,
    });
  });
});
